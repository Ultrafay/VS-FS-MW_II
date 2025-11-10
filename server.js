require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Configuration
const FRESHCHAT_API_KEY = process.env.FRESHCHAT_API_KEY;
const FRESHCHAT_API_URL = process.env.FRESHCHAT_API_URL || 'https://empirica-906850564203647665.myfreshworks.com/';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const BOT_AGENT_ID = process.env.FRESHCHAT_BOT_AGENT_ID;

// Validate environment variables
console.log('\n' + '='.repeat(70));
console.log('🔍 ENVIRONMENT VARIABLES CHECK:');
console.log('='.repeat(70));
console.log('FRESHCHAT_API_KEY:', FRESHCHAT_API_KEY ? '✅ Set' : '❌ Missing');
console.log('FRESHCHAT_API_URL:', FRESHCHAT_API_URL);
console.log('OPENAI_API_KEY:', OPENAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('ASSISTANT_ID:', ASSISTANT_ID || '❌ Missing');
console.log('BOT_AGENT_ID:', BOT_AGENT_ID || '❌ Missing');
console.log('='.repeat(70) + '\n');

if (!FRESHCHAT_API_KEY || !OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error('❌ Missing required environment variables!');
  console.error('Required: FRESHCHAT_API_KEY, OPENAI_API_KEY, ASSISTANT_ID');
  console.error('Optional but recommended: FRESHCHAT_BOT_AGENT_ID');
  process.exit(1);
}

const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID
});

// Store conversation threads
const conversationThreads = new Map();

// Logging helper
function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Send message to Freshchat - TRIES MULTIPLE FORMATS
async function sendFreshchatMessage(conversationId, message, channelId = null) {
  const attempts = [
    // Attempt 1: With actor_id
    {
      name: 'Format 1: With actor_id',
      payload: BOT_AGENT_ID ? {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'agent',
        actor_id: BOT_AGENT_ID
      } : null
    },
    // Attempt 2: Without actor_id
    {
      name: 'Format 2: Without actor_id',
      payload: {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'agent'
      }
    },
    // Attempt 3: With channel_id (if available)
    {
      name: 'Format 3: With channel_id',
      payload: channelId ? {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'agent',
        channel_id: channelId
      } : null
    },
    // Attempt 4: System actor type
    {
      name: 'Format 4: System actor',
      payload: {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'system'
      }
    },
    // Attempt 5: Minimal payload
    {
      name: 'Format 5: Minimal',
      payload: {
        message_parts: [{ text: { content: message } }]
      }
    }
  ].filter(attempt => attempt.payload !== null);

  log('📤', `Attempting to send message to conversation: ${conversationId}`);
  log('📝', `Message: ${message.substring(0, 100)}...`);

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    
    try {
      log('🔄', `Attempt ${i + 1}/${attempts.length}: ${attempt.name}`);
      log('📦', 'Payload:', attempt.payload);
      
      const response = await axios.post(
        `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
        attempt.payload,
        {
          headers: {
            'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      
      log('✅', `SUCCESS with ${attempt.name}!`);
      log('📬', 'Response status:', response.status);
      log('📬', 'Response data:', response.data);
      
      return response.data;
      
    } catch (error) {
      log('❌', `Failed with ${attempt.name}`);
      log('❌', `Status: ${error.response?.status}`);
      log('❌', `Error:`, error.response?.data);
      
      // If this is the last attempt, throw the error
      if (i === attempts.length - 1) {
        log('💥', 'ALL ATTEMPTS FAILED!');
        log('💥', 'Last error details:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          headers: error.response?.headers
        });
        throw error;
      }
      
      log('🔄', 'Trying next format...');
      await new Promise(resolve => setTimeout(resolve, 500)); // Small delay
    }
  }
}

// Assign conversation to human agent
async function assignToHumanAgent(conversationId) {
  try {
    log('🚨', `Attempting to escalate conversation ${conversationId}`);
    
    await axios.put(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
      {
        status: 'assigned'
      },
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    log('✅', `Conversation ${conversationId} escalated to human agent`);
    return true;
  } catch (error) {
    log('❌', 'Error escalating to agent:', error.response?.data || error.message);
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
      log('🆕', `New thread created: ${thread.id}`);
    } else {
      thread = { id: threadId };
      log('♻️', `Using existing thread: ${threadId}`);
    }

    log('📝', `Adding message to thread ${thread.id}`);
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMessage
    });

    log('▶️', `Starting assistant run with ${ASSISTANT_ID}`);
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID
    });

    log('⏳', `Waiting for assistant response (run ${run.id})...`);

    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 60;

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
      
      if (attempts % 10 === 0) {
        log('⏳', `Still waiting... Status: ${runStatus.status} (${attempts}s)`);
      }

      if (runStatus.status === 'failed' || runStatus.status === 'expired') {
        log('❌', `Assistant run ${runStatus.status}`, runStatus);
        throw new Error(`Assistant run ${runStatus.status}`);
      }
    }

    if (attempts >= maxAttempts) {
      log('❌', 'Assistant response timeout after 60 seconds');
      throw new Error('Assistant response timeout');
    }

    log('✅', `Assistant completed after ${attempts} seconds`);
    
    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data[0].content[0].text.value;
    log('🤖', `Assistant response: ${assistantMessage.substring(0, 200)}...`);

    const needsEscalation = assistantMessage.includes('ESCALATE_TO_HUMAN');
    
    let cleanMessage = assistantMessage;
    let escalationReason = '';
    
    if (needsEscalation) {
      const match = assistantMessage.match(/ESCALATE_TO_HUMAN:\s*(.+)/);
      escalationReason = match ? match[1].trim() : 'User request';
      cleanMessage = assistantMessage.replace(/ESCALATE_TO_HUMAN:.+/g, '').trim();
      
      if (!cleanMessage) {
        cleanMessage = "Let me connect you with one of our team members who can better assist you.";
      }
      log('🚨', `Escalation needed: ${escalationReason}`);
    }

    return {
      response: cleanMessage,
      threadId: thread.id,
      needsEscalation,
      escalationReason
    };

  } catch (error) {
    log('❌', 'OpenAI Assistant error:', error.message);
    throw error;
  }
}

// Process message asynchronously
async function processMessageAsync(conversationId, messageContent, channelId = null) {
  try {
    log('🔄', '═'.repeat(70));
    log('🔄', `Processing message for conversation ${conversationId}`);
    log('💬', `Message: "${messageContent}"`);
    log('🔄', '═'.repeat(70));

    let threadId = conversationThreads.get(conversationId);

    const { response, threadId: newThreadId, needsEscalation, escalationReason } = 
      await getAssistantResponse(messageContent, threadId);

    conversationThreads.set(conversationId, newThreadId);
    log('💾', `Saved thread ${newThreadId} for conversation ${conversationId}`);

    log('📤', 'Sending assistant response to Freshchat...');
    await sendFreshchatMessage(conversationId, response, channelId);

    if (needsEscalation) {
      log('🚨', `Escalating: ${escalationReason}`);
      await assignToHumanAgent(conversationId);
      await sendFreshchatMessage(
        conversationId, 
        'A team member will be with you shortly. Thank you for your patience!',
        channelId
      );
    }

    log('✅', '═'.repeat(70));
    log('✅', `Message processing completed for ${conversationId}`);
    log('✅', '═'.repeat(70));

  } catch (error) {
    log('❌', '═'.repeat(70));
    log('❌', `Error processing message for ${conversationId}`);
    log('❌', 'Error:', error.message);
    log('❌', '═'.repeat(70));
    
    try {
      await sendFreshchatMessage(
        conversationId,
        "I'm having trouble processing your request. Let me connect you with a human agent.",
        channelId
      );
      await assignToHumanAgent(conversationId);
    } catch (fallbackError) {
      log('❌', 'Failed to send error message:', fallbackError.message);
    }
  }
}

// Main webhook endpoint
app.post('/freshchat-webhook', async (req, res) => {
  try {
    // Respond immediately (within 3 seconds)
    res.status(200).json({ success: true, message: 'Webhook received' });
    
    log('📥', '═'.repeat(70));
    log('📥', 'WEBHOOK RECEIVED');
    log('📥', '═'.repeat(70));
    log('📋', 'Full webhook body:', req.body);
    
    const { actor, action, data } = req.body;
    
    log('📋', 'Parsed data:', {
      actor_type: actor?.actor_type,
      actor_id: actor?.actor_id,
      action: action,
      has_message: !!data?.message,
      conversation_id: data?.message?.conversation_id,
      channel_id: data?.message?.channel_id
    });
    
    // Only process user messages
    if (action === 'message_create' && actor?.actor_type === 'user') {
      
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      const channelId = data?.message?.channel_id;
      
      if (!conversationId || !messageContent) {
        log('⚠️', 'Missing required data:', {
          has_conversation_id: !!conversationId,
          has_message_content: !!messageContent
        });
        return;
      }

      log('💬', `User message received in conversation ${conversationId}`);
      log('💬', `Message: "${messageContent}"`);
      if (channelId) log('📡', `Channel ID: ${channelId}`);

      // Process asynchronously
      log('🚀', 'Starting async processing...');
      processMessageAsync(conversationId, messageContent, channelId)
        .catch(err => log('❌', 'Async error:', err.message));
      
    } else {
      log('ℹ️', `Ignoring: action=${action}, actor_type=${actor?.actor_type}`);
    }
    
  } catch (error) {
    log('❌', 'Webhook error:', error.message);
  }
});

// Debug endpoint to test message sending
app.get('/debug-send', async (req, res) => {
  const conversationId = req.query.cid;
  
  if (!conversationId) {
    return res.json({ 
      error: 'Missing conversation_id', 
      usage: '/debug-send?cid=YOUR_CONVERSATION_ID' 
    });
  }
  
  const results = [];
  
  const formats = [
    {
      name: 'With actor_id',
      payload: BOT_AGENT_ID ? {
        message_parts: [{ text: { content: 'Debug test 1' } }],
        message_type: 'normal',
        actor_type: 'agent',
        actor_id: BOT_AGENT_ID
      } : null
    },
    {
      name: 'Without actor_id',
      payload: {
        message_parts: [{ text: { content: 'Debug test 2' } }],
        message_type: 'normal',
        actor_type: 'agent'
      }
    },
    {
      name: 'System actor',
      payload: {
        message_parts: [{ text: { content: 'Debug test 3' } }],
        message_type: 'normal',
        actor_type: 'system'
      }
    },
    {
      name: 'Minimal',
      payload: {
        message_parts: [{ text: { content: 'Debug test 4' } }]
      }
    }
  ].filter(f => f.payload !== null);
  
  for (const format of formats) {
    try {
      const response = await axios.post(
        `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
        format.payload,
        {
          headers: {
            'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      results.push({
        format: format.name,
        status: '✅ SUCCESS',
        statusCode: response.status,
        response: response.data
      });
      
    } catch (error) {
      results.push({
        format: format.name,
        status: '❌ FAILED',
        statusCode: error.response?.status,
        error: error.response?.data || error.message
      });
    }
  }
  
  res.json({
    conversationId,
    apiUrl: FRESHCHAT_API_URL,
    botAgentId: BOT_AGENT_ID,
    timestamp: new Date().toISOString(),
    results
  });
});

// Test API connections
app.get('/test-connections', async (req, res) => {
  const results = {};

  // Test OpenAI
  try {
    await openai.models.list();
    results.openai = '✅ Connected';
  } catch (error) {
    results.openai = `❌ Failed: ${error.message}`;
  }

  // Test Freshchat
  try {
    const response = await axios.get(
      `${FRESHCHAT_API_URL}/accounts/configuration`,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    results.freshchat = '✅ Connected';
    results.freshchat_account = response.data;
  } catch (error) {
    results.freshchat = `❌ Failed: ${error.response?.status} - ${error.message}`;
    results.freshchat_error = error.response?.data;
  }

  res.json(results);
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeThreads: conversationThreads.size,
    config: {
      freshchat_api_url: FRESHCHAT_API_URL,
      has_api_key: !!FRESHCHAT_API_KEY,
      has_openai_key: !!OPENAI_API_KEY,
      has_assistant_id: !!ASSISTANT_ID,
      has_bot_agent_id: !!BOT_AGENT_ID
    }
  });
});

// Test configuration
app.get('/test', (req, res) => {
  res.status(200).json({
    status: 'Server running',
    version: '3.0.0',
    config: {
      freshchat_api_url: FRESHCHAT_API_URL,
      freshchat_key: !!FRESHCHAT_API_KEY,
      openai_key: !!OPENAI_API_KEY,
      assistant_id: ASSISTANT_ID || 'Not set',
      bot_agent_id: BOT_AGENT_ID || 'Not set'
    },
    activeThreads: conversationThreads.size,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'Freshchat-OpenAI Integration Server',
    version: '3.0.0',
    endpoints: {
      webhook: 'POST /freshchat-webhook',
      health: 'GET /health',
      test: 'GET /test',
      test_connections: 'GET /test-connections',
      debug_send: 'GET /debug-send?cid=CONVERSATION_ID'
    },
    status: 'running',
    docs: 'Visit /test to check configuration'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 Freshchat-OpenAI Integration Server Started');
  console.log('='.repeat(70));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Webhook: POST /freshchat-webhook`);
  console.log(`❤️  Health: GET /health`);
  console.log(`🧪 Test: GET /test`);
  console.log(`🔌 Connections: GET /test-connections`);
  console.log(`🐛 Debug: GET /debug-send?cid=CONVERSATION_ID`);
  console.log('='.repeat(70) + '\n');
});
