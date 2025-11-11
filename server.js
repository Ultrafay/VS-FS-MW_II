require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Configuration
const FRESHCHAT_API_KEY = process.env.FRESHCHAT_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;

const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY
});

const conversationThreads = new Map();
const FRESHCHAT_API_URL = 'https://api.freshchat.com/v2';

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Send message to Freshchat - SIMPLIFIED
async function sendFreshchatMessage(conversationId, message) {
  try {
    log('📤', `Sending message to conversation: ${conversationId}`);
    
    // Try different payload formats
    const payloads = [
      // Format 1: Simple message
      {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal'
      },
      // Format 2: With actor type
      {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'system'
      },
      // Format 3: With bot actor
      {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'bot'
      }
    ];

    for (let i = 0; i < payloads.length; i++) {
      try {
        log('🔄', `Trying format ${i + 1}`);
        
        const response = await axios.post(
          `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
          payloads[i],
          {
            headers: {
              'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );

        log('✅', `Message sent successfully with format ${i + 1}`);
        return response.data;
      } catch (error) {
        log('❌', `Format ${i + 1} failed:`, error.response?.data || error.message);
        
        // If this is the last attempt, throw the error
        if (i === payloads.length - 1) {
          throw error;
        }
      }
    }
  } catch (error) {
    log('💥', 'All message sending attempts failed:', error.message);
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
      log('🆕', `New thread: ${thread.id}`);
    } else {
      thread = { id: threadId };
      log('♻️', `Using thread: ${threadId}`);
    }

    // Add user message to thread
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMessage
    });

    // Run assistant
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID
    });

    log('⏳', 'Waiting for assistant...');

    // Poll for completion
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 30;

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      if (runStatus.status === 'failed') {
        throw new Error(`Assistant run failed: ${runStatus.last_error?.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
    }

    if (runStatus.status !== 'completed') {
      throw new Error(`Assistant timeout - status: ${runStatus.status}`);
    }

    // Get the latest assistant message
    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data
      .filter(msg => msg.role === 'assistant')
      .sort((a, b) => b.created_at - a.created_at)[0];

    if (!assistantMessage) {
      throw new Error('No assistant response found');
    }

    const responseText = assistantMessage.content[0].text.value;
    log('🤖', `Assistant response: ${responseText.substring(0, 200)}...`);

    // Check for escalation triggers
    const needsEscalation = 
      responseText.toLowerCase().includes('connect you with my manager') ||
      responseText.toLowerCase().includes('escalate') ||
      responseText.toLowerCase().includes('human agent') ||
      responseText.includes('ESCALATE_TO_HUMAN');

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

// SIMPLIFIED WEBHOOK HANDLER
app.post('/freshchat-webhook', async (req, res) => {
  log('📥', '═'.repeat(50));
  log('📥', 'WEBHOOK RECEIVED');
  log('📥', 'Full webhook body:', JSON.stringify(req.body, null, 2));
  log('📥', '═'.repeat(50));

  // Immediately respond to Freshchat
  res.status(200).json({ status: 'received' });

  try {
    // Extract data from different possible webhook formats
    let conversationId, messageContent, actorType;

    // Format 1: Standard Freshchat format
    if (req.body.data && req.body.data.conversation_id) {
      conversationId = req.body.data.conversation_id;
      messageContent = req.body.data.message_parts?.[0]?.text?.content;
      actorType = req.body.actor?.type;
    }
    // Format 2: Alternative format
    else if (req.body.conversation_id) {
      conversationId = req.body.conversation_id;
      messageContent = req.body.message_parts?.[0]?.text?.content;
      actorType = req.body.actor_type;
    }
    // Format 3: Direct message format
    else if (req.body.message) {
      conversationId = req.body.message.conversation_id;
      messageContent = req.body.message.message_parts?.[0]?.text?.content;
      actorType = req.body.message.actor_type;
    }

    log('🔍', 'Extracted data:', {
      conversationId,
      messageContent: messageContent ? `${messageContent.substring(0, 50)}...` : 'None',
      actorType
    });

    // Validate required data
    if (!conversationId || !messageContent) {
      log('❌', 'Missing conversationId or messageContent');
      return;
    }

    // Only process user messages
    if (actorType !== 'user') {
      log('⚠️', `Ignoring non-user message from: ${actorType}`);
      return;
    }

    // Process message asynchronously
    processMessageAsync(conversationId, messageContent);
    
  } catch (error) {
    log('💥', 'Webhook processing error:', error.message);
  }
});

// Async message processing
async function processMessageAsync(conversationId, messageContent) {
  try {
    log('🔄', `Processing message for conversation: ${conversationId}`);
    
    let threadId = conversationThreads.get(conversationId);
    
    const { response, threadId: newThreadId, needsEscalation } = 
      await getAssistantResponse(messageContent, threadId);

    conversationThreads.set(conversationId, newThreadId);

    // Send response to Freshchat
    await sendFreshchatMessage(conversationId, response);

    if (needsEscalation) {
      log('🚨', 'Escalation triggered - would connect to human agent here');
      // You can implement human agent assignment logic here
    }

    log('✅', 'Message processing completed');

  } catch (error) {
    log('❌', 'Message processing failed:', error.message);
    
    // Send error message to user
    try {
      await sendFreshchatMessage(
        conversationId, 
        "I'm having trouble right now. Please try again or contact support."
      );
    } catch (fallbackError) {
      log('💥', 'Even fallback message failed:', fallbackError.message);
    }
  }
}

// TEST ENDPOINT - Use this to find your conversation IDs
app.post('/test-send', async (req, res) => {
  const { conversationId, message } = req.body;
  
  if (!conversationId) {
    return res.status(400).json({ 
      error: 'Missing conversationId',
      usage: 'Send a POST request with { "conversationId": "YOUR_CONVERSATION_ID", "message": "Test message" }'
    });
  }

  try {
    const testMessage = message || "Hello! This is a test message from the OpenAI integration.";
    
    log('🧪', `TEST: Sending message to conversation: ${conversationId}`);
    
    const result = await sendFreshchatMessage(conversationId, testMessage);
    
    res.json({
      success: true,
      conversationId,
      message: testMessage,
      result: result
    });
    
  } catch (error) {
    log('❌', 'Test failed:', error.message);
    res.status(500).json({
      error: error.message,
      conversationId
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeThreads: conversationThreads.size
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('🚀 Server started on port', PORT);
  console.log('📍 Webhook URL: POST /freshchat-webhook');
  console.log('🧪 Test URL: POST /test-send');
  console.log('❤️  Health: GET /health');
  console.log('\n📝 NEXT STEPS:');
  console.log('1. Start a conversation in Freshchat to get conversation IDs');
  console.log('2. Use POST /test-send with conversationId to test messaging');
  console.log('3. Check logs to see webhook data structure');
});
