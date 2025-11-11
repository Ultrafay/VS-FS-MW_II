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
const BOT_AGENT_ID = process.env.FRESHCHAT_BOT_AGENT_ID;

const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY
});

const conversationThreads = new Map();
let WORKING_API_URL = 'https://api.freshchat.com/v2';

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Send message to Freshchat - SIMPLIFIED VERSION
async function sendFreshchatMessage(conversationId, message) {
  try {
    log('📤', `Sending message to conversation: ${conversationId}`);
    
    const payload = {
      message_parts: [{ text: { content: message } }],
      message_type: 'normal'
    };

    // Add actor_id if available
    if (BOT_AGENT_ID) {
      payload.actor_type = 'agent';
      payload.actor_id = BOT_AGENT_ID;
    }

    const response = await axios.post(
      `${WORKING_API_URL}/conversations/${conversationId}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    log('✅', 'Message sent successfully to Freshchat');
    return response.data;
  } catch (error) {
    log('❌', 'Failed to send message to Freshchat:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}

// Assign conversation to bot agent
async function assignConversationToBot(conversationId) {
  try {
    if (!BOT_AGENT_ID) {
      log('⚠️', 'No BOT_AGENT_ID set, skipping assignment');
      return;
    }

    const response = await axios.put(
      `${WORKING_API_URL}/conversations/${conversationId}`,
      {
        assigned_agent_id: BOT_AGENT_ID,
        status: 'assigned'
      },
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    log('✅', `Conversation ${conversationId} assigned to bot`);
    return response.data;
  } catch (error) {
    log('❌', 'Failed to assign conversation to bot:', error.response?.data || error.message);
    // Don't throw - this might not be critical
  }
}

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

    // Check for escalation
    const needsEscalation = responseText.includes('connect you with my manager') || 
                           responseText.includes('escalate') ||
                           responseText.toLowerCase().includes('human');

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

// CORRECTED WEBHOOK HANDLER
app.post('/freshchat-webhook', async (req, res) => {
  log('📥', '═'.repeat(50));
  log('📥', 'WEBHOOK RECEIVED');
  log('📥', 'Full webhook body:', req.body);
  log('📥', '═'.repeat(50));

  // Immediately respond to Freshchat to avoid timeout
  res.status(200).json({ status: 'received' });

  try {
    // Freshchat webhooks can have different structures
    // Try multiple possible structures
    let conversationId, messageContent, actorType;

    // Structure 1: Standard Freshchat webhook
    if (req.body.data?.conversation_id) {
      conversationId = req.body.data.conversation_id;
      messageContent = req.body.data.message_parts?.[0]?.text?.content;
      actorType = req.body.actor?.type; // 'user' or 'agent'
    }
    // Structure 2: Alternative format
    else if (req.body.conversation_id) {
      conversationId = req.body.conversation_id;
      messageContent = req.body.message_parts?.[0]?.text?.content;
      actorType = req.body.actor_type;
    }
    // Structure 3: Message create event
    else if (req.body.action === 'onMessageCreate' && req.body.data) {
      conversationId = req.body.data.conversationId;
      messageContent = req.body.data.messageParts?.[0]?.text?.content;
      actorType = req.body.data.actorType;
    }

    log('🔍', 'Extracted data:', {
      conversationId,
      messageContent,
      actorType,
      hasBody: !!req.body
    });

    // Validate we have required data
    if (!conversationId || !messageContent) {
      log('❌', 'Missing conversationId or messageContent');
      return;
    }

    // Only process user messages, ignore bot messages
    if (actorType !== 'user' && actorType !== 'customer') {
      log('⚠️', `Ignoring non-user message from actorType: ${actorType}`);
      return;
    }

    log('💬', `Processing user message: "${messageContent}"`);

    // Assign conversation to bot first
    await assignConversationToBot(conversationId);

    // Process the message
    let threadId = conversationThreads.get(conversationId);
    
    const { response, threadId: newThreadId, needsEscalation } = 
      await getAssistantResponse(messageContent, threadId);

    conversationThreads.set(conversationId, newThreadId);

    // Send the response to Freshchat
    await sendFreshchatMessage(conversationId, response);

    if (needsEscalation) {
      log('🚨', 'Escalating to human agent');
      // For escalation, you might want to reassign to a human agent
      // This would require knowing a human agent ID
    }

    log('✅', 'Message processing completed successfully');

  } catch (error) {
    log('💥', 'Webhook processing error:', error.message);
    log('💥', 'Error stack:', error.stack);
  }
});

// Test endpoint to simulate webhook
app.post('/test-webhook', async (req, res) => {
  const { conversationId, message } = req.body;
  
  if (!conversationId || !message) {
    return res.status(400).json({ error: 'Missing conversationId or message' });
  }

  try {
    log('🧪', 'TEST: Simulating webhook');
    
    // Assign to bot
    await assignConversationToBot(conversationId);
    
    // Get OpenAI response
    const { response } = await getAssistantResponse(message);
    
    // Send to Freshchat
    await sendFreshchatMessage(conversationId, response);
    
    res.json({ 
      success: true, 
      conversationId, 
      response: response.substring(0, 100) + '...' 
    });
    
  } catch (error) {
    log('❌', 'Test failed:', error.message);
    res.status(500).json({ error: error.message });
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
  console.log('🧪 Test URL: POST /test-webhook');
  console.log('❤️  Health: GET /health');
});
