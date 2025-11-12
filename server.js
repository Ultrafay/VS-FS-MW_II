require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Configuration
const FRESHCHAT_API_KEY = process.env.FRESHCHAT_API_KEY;
const FRESHCHAT_API_URL = process.env.FRESHCHAT_API_URL || 'https://api.freshchat.com/v2';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const BOT_AGENT_ID = process.env.FRESHCHAT_BOT_AGENT_ID;

// Validate environment variables
console.log('\n' + '='.repeat(70));
console.log('🔍 Configuration Check:');
console.log('='.repeat(70));
console.log('FRESHCHAT_API_KEY:', FRESHCHAT_API_KEY ? '✅ Set' : '❌ Missing');
console.log('FRESHCHAT_API_URL:', FRESHCHAT_API_URL);
console.log('OPENAI_API_KEY:', OPENAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('ASSISTANT_ID:', ASSISTANT_ID || '❌ Missing');
console.log('BOT_AGENT_ID:', BOT_AGENT_ID || '⚠️ Not set (optional)');
console.log('='.repeat(70) + '\n');

if (!FRESHCHAT_API_KEY || !OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error('❌ Missing required environment variables!');
  process.exit(1);
}

const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID
});

const conversationThreads = new Map();

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Send message to Freshchat
async function sendFreshchatMessage(conversationId, message) {
  try {
    log('📤', `Sending message to conversation: ${conversationId}`);
    log('📝', `Message: ${message.substring(0, 100)}...`);
    
    // Try format 1: With actor_id (if available)
    const payload1 = BOT_AGENT_ID ? {
      message_parts: [{ text: { content: message } }],
      message_type: 'normal',
      actor_type: 'agent',
      actor_id: BOT_AGENT_ID
    } : null;
    
    // Try format 2: Without actor_id
    const payload2 = {
      message_parts: [{ text: { content: message } }],
      message_type: 'normal',
      actor_type: 'agent'
    };

    const attempts = [payload1, payload2].filter(p => p !== null);

    for (let i = 0; i < attempts.length; i++) {
      try {
        log('🔄', `Attempt ${i + 1}/${attempts.length}`);
        log('📦', 'Payload:', attempts[i]);
        
        const response = await axios.post(
          `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
          attempts[i],
          {
            headers: {
              'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );
        
        log('✅', `Message sent successfully!`);
        log('📬', 'Response:', response.data);
        return response.data;
        
      } catch (error) {
        log('❌', `Attempt ${i + 1} failed:`, {
          status: error.response?.status,
          error: error.response?.data || error.message
        });
        
        if (i === attempts.length - 1) {
          throw error; // Last attempt failed
        }
      }
    }
    
  } catch (error) {
    log('💥', 'All attempts to send message failed');
    throw error;
  }
}

// Get response from OpenAI Assistant
async function getAssistantResponse(userMessage, threadId = null) {
  try {
    log('🤖', `Getting OpenAI response for: "${userMessage}"`);
    
    let thread;
    if (!threadId) {
      thread = await openai.beta.threads.create();
      log('🆕', `Created new thread: ${thread.id}`);
    } else {
      thread = { id: threadId };
      log('♻️', `Using existing thread: ${threadId}`);
    }

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMessage
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID
    });

    log('⏳', `Waiting for assistant response (run: ${run.id})...`);

    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 60;

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      if (runStatus.status === 'failed') {
        throw new Error(`Assistant run failed: ${runStatus.last_error?.message}`);
      }
      if (runStatus.status === 'expired') {
        throw new Error('Assistant run expired');
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
      
      if (attempts % 10 === 0) {
        log('⏳', `Still waiting... (${attempts}s, status: ${runStatus.status})`);
      }
    }

    if (runStatus.status !== 'completed') {
      throw new Error(`Assistant timeout after ${attempts}s (status: ${runStatus.status})`);
    }

    log('✅', `Assistant completed in ${attempts} seconds`);

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data
      .filter(msg => msg.role === 'assistant')
      .sort((a, b) => b.created_at - a.created_at)[0];

    if (!assistantMessage) {
      throw new Error('No assistant response found');
    }

    const responseText = assistantMessage.content[0].text.value;
    log('🤖', `Assistant said: ${responseText.substring(0, 200)}...`);

    const needsEscalation = responseText.toLowerCase().includes('connect you with my manager') || 
                           responseText.toLowerCase().includes('escalate');

    return {
      response: responseText,
      threadId: thread.id,
      needsEscalation
    };

  } catch (error) {
    log('❌', 'OpenAI error:', error.message);
    throw error;
  }
}

// Process message asynchronously
async function processMessage(conversationId, messageContent) {
  try {
    log('🔄', '═'.repeat(70));
    log('🔄', `Processing conversation: ${conversationId}`);
    log('💬', `User message: "${messageContent}"`);
    log('🔄', '═'.repeat(70));

    // Get existing thread or create new one
    let threadId = conversationThreads.get(conversationId);

    // Get OpenAI response
    const { response, threadId: newThreadId, needsEscalation } = 
      await getAssistantResponse(messageContent, threadId);

    // Save thread for this conversation
    conversationThreads.set(conversationId, newThreadId);
    log('💾', `Saved thread ${newThreadId} for conversation ${conversationId}`);

    // Send response to Freshchat
    await sendFreshchatMessage(conversationId, response);

    if (needsEscalation) {
      log('🚨', 'Escalation detected - notifying user');
      // You could assign to human agent here if needed
    }

    log('✅', '═'.repeat(70));
    log('✅', `Successfully processed conversation ${conversationId}`);
    log('✅', '═'.repeat(70));

  } catch (error) {
    log('💥', '═'.repeat(70));
    log('💥', `Error processing conversation ${conversationId}`);
    log('💥', 'Error:', error.message);
    log('💥', 'Stack:', error.stack);
    log('💥', '═'.repeat(70));
    
    // Try to send error message to user
    try {
      await sendFreshchatMessage(
        conversationId,
        "I apologize, but I'm having trouble processing your request. A team member will assist you shortly."
      );
    } catch (fallbackError) {
      log('❌', 'Failed to send error message:', fallbackError.message);
    }
  }
}

// CORRECT Webhook handler for Freshchat
app.post('/freshchat-webhook', async (req, res) => {
  // IMMEDIATELY respond to avoid timeout
  res.status(200).json({ success: true });
  
  log('📥', '═'.repeat(70));
  log('📥', 'WEBHOOK RECEIVED');
  log('📥', '═'.repeat(70));
  log('📋', 'Full webhook body:', req.body);
  
  try {
    const { actor, action, data } = req.body;
    
    log('📋', 'Extracted:', {
      action,
      actor_type: actor?.actor_type,
      has_data: !!data,
      has_message: !!data?.message
    });
    
    // Only process user messages (message_create event from users)
    if (action === 'message_create' && actor?.actor_type === 'user') {
      
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      
      log('🔍', 'Message data:', {
        conversationId,
        messageContent,
        has_both: !!(conversationId && messageContent)
      });
      
      if (!conversationId || !messageContent) {
        log('⚠️', 'Missing conversation ID or message content');
        return;
      }

      log('💬', `Processing user message: "${messageContent}"`);
      log('📍', `Conversation ID: ${conversationId}`);

      // Process asynchronously (don't wait)
      processMessage(conversationId, messageContent)
        .catch(err => log('❌', 'Async processing error:', err.message));
      
    } else {
      log('ℹ️', `Ignoring webhook: action=${action}, actor_type=${actor?.actor_type}`);
    }
    
  } catch (error) {
    log('💥', 'Webhook processing error:', error.message);
    log('💥', 'Stack:', error.stack);
  }
});

// Manual test endpoint
app.post('/test-message', async (req, res) => {
  const { conversation_id, message } = req.body;
  
  if (!conversation_id || !message) {
    return res.status(400).json({
      error: 'Missing parameters',
      required: { conversation_id: 'string', message: 'string' }
    });
  }

  try {
    log('🧪', `Manual test: conversation=${conversation_id}`);
    
    // Get OpenAI response
    let threadId = conversationThreads.get(conversation_id);
    const { response, threadId: newThreadId } = 
      await getAssistantResponse(message, threadId);
    
    conversationThreads.set(conversation_id, newThreadId);
    
    // Send to Freshchat
    await sendFreshchatMessage(conversation_id, response);
    
    res.json({
      success: true,
      conversation_id,
      response: response.substring(0, 200) + '...',
      thread_id: newThreadId
    });
    
  } catch (error) {
    log('❌', 'Test failed:', error.message);
    res.status(500).json({
      error: error.message,
      conversation_id
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    version: '5.0.0',
    timestamp: new Date().toISOString(),
    config: {
      freshchat_api_url: FRESHCHAT_API_URL,
      has_api_key: !!FRESHCHAT_API_KEY,
      has_openai_key: !!OPENAI_API_KEY,
      has_assistant_id: !!ASSISTANT_ID,
      has_bot_agent_id: !!BOT_AGENT_ID
    },
    activeThreads: conversationThreads.size
  });
});

// Configuration test
app.get('/test-config', async (req, res) => {
  const results = {
    timestamp: new Date().toISOString(),
    environment: {
      FRESHCHAT_API_KEY: !!FRESHCHAT_API_KEY,
      FRESHCHAT_API_URL: FRESHCHAT_API_URL,
      OPENAI_API_KEY: !!OPENAI_API_KEY,
      ASSISTANT_ID: !!ASSISTANT_ID,
      BOT_AGENT_ID: BOT_AGENT_ID || 'Not set'
    },
    tests: {}
  };

  // Test OpenAI
  try {
    await openai.models.list();
    results.tests.openai = '✅ Connected';
  } catch (error) {
    results.tests.openai = `❌ Failed: ${error.message}`;
  }

  // Test Freshchat
  try {
    const response = await axios.get(
      `${FRESHCHAT_API_URL}/accounts/configuration`,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    results.tests.freshchat = '✅ Connected';
    results.tests.freshchat_account = response.data;
  } catch (error) {
    results.tests.freshchat = `❌ Failed: ${error.response?.status} - ${error.message}`;
    results.tests.freshchat_error = error.response?.data;
  }

  res.json(results);
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Freshchat-OpenAI Integration',
    version: '5.0.0',
    status: 'running',
    endpoints: {
      webhook: 'POST /freshchat-webhook',
      test_message: 'POST /test-message (body: {conversation_id, message})',
      health: 'GET /health',
      test_config: 'GET /test-config'
    },
    docs: 'Send POST to /test-message to manually test'
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 Freshchat-OpenAI Integration Server Started');
  console.log('='.repeat(70));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Webhook: POST /freshchat-webhook`);
  console.log(`🧪 Test: POST /test-message`);
  console.log(`❤️  Health: GET /health`);
  console.log(`🔧 Config: GET /test-config`);
  console.log('='.repeat(70) + '\n');
});
