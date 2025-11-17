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
const HUMAN_AGENT_ID = process.env.HUMAN_AGENT_ID;

// Use the standard Freshchat API URL
const WORKING_API_URL = 'https://api.freshchat.com/v2';

// Validate environment variables
console.log('\n' + '='.repeat(70));
console.log('🔍 Configuration Check:');
console.log('='.repeat(70));
console.log('FRESHCHAT_API_KEY:', FRESHCHAT_API_KEY ? '✅ Set' : '❌ Missing');
console.log('FRESHCHAT_API_URL:', WORKING_API_URL);
console.log('OPENAI_API_KEY:', OPENAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('ASSISTANT_ID:', ASSISTANT_ID || '❌ Missing');
console.log('BOT_AGENT_ID:', BOT_AGENT_ID || '⚠️ Not set (optional)');
console.log('HUMAN_AGENT_ID:', HUMAN_AGENT_ID || '⚠️ Not set (for escalation)');
console.log('='.repeat(70) + '\n');

if (!FRESHCHAT_API_KEY || !OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error('❌ Missing required environment variables!');
  process.exit(1);
}

const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY
});

const conversationThreads = new Map();
const escalatedConversations = new Set();

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Send message to Freshchat - SIMPLIFIED VERSION (from working code)
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

// Check if conversation is with human agent
async function isConversationWithHuman(conversationId) {
  try {
    const response = await axios.get(
      `${WORKING_API_URL}/conversations/${conversationId}`,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    const conversation = response.data;
    const assignedAgentId = conversation.assigned_agent_id;
    
    log('🔍', `Conversation ${conversationId} assigned to agent: ${assignedAgentId || 'none'}`);

    // If assigned to human agent OR in escalated list
    if (assignedAgentId && assignedAgentId !== BOT_AGENT_ID) {
      log('👨‍💼', `Conversation is with human agent (${assignedAgentId})`);
      return true;
    }

    if (escalatedConversations.has(conversationId)) {
      log('🚨', 'Conversation is in escalated list');
      return true;
    }

    log('🤖', 'Conversation is still with bot');
    return false;

  } catch (error) {
    log('❌', 'Error checking conversation assignment:', error.message);
    return false;
  }
}

// Escalate to human agent
async function escalateToHuman(conversationId) {
  try {
    if (!HUMAN_AGENT_ID) {
      log('⚠️', 'No HUMAN_AGENT_ID set, marking as escalated but not reassigning');
      escalatedConversations.add(conversationId);
      return true;
    }

    log('🚨', `Escalating conversation ${conversationId} to human agent ${HUMAN_AGENT_ID}`);

    const response = await axios.put(
      `${WORKING_API_URL}/conversations/${conversationId}`,
      {
        assigned_agent_id: HUMAN_AGENT_ID,
        status: 'assigned'
      },
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    log('✅', `Conversation reassigned to human agent`);
    escalatedConversations.add(conversationId);

    await sendFreshchatMessage(
      conversationId,
      "I'm connecting you with a team member who will be with you shortly. 👋"
    );

    return true;

  } catch (error) {
    log('❌', 'Failed to escalate conversation:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    
    escalatedConversations.add(conversationId);
    return false;
  }
}

// Return conversation to bot
async function returnToBot(conversationId) {
  try {
    log('🔄', `Returning conversation ${conversationId} to bot`);

    if (BOT_AGENT_ID) {
      await axios.put(
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
      log('✅', `Conversation reassigned to bot agent ${BOT_AGENT_ID}`);
    }

    escalatedConversations.delete(conversationId);
    log('✅', `Removed conversation ${conversationId} from escalated list`);

    await sendFreshchatMessage(
      conversationId,
      "I'm back! How can I help you today? 😊"
    );

    return true;

  } catch (error) {
    log('❌', 'Failed to return conversation to bot:', error.message);
    escalatedConversations.delete(conversationId);
    return false;
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

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMessage
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID
    });

    log('⏳', 'Waiting for assistant...');

    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 60;

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      if (runStatus.status === 'failed') {
        throw new Error(`Assistant run failed: ${runStatus.last_error?.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
      
      if (attempts % 10 === 0) {
        log('⏳', `Still waiting... (${attempts}s)`);
      }
    }

    if (runStatus.status !== 'completed') {
      throw new Error(`Assistant timeout - status: ${runStatus.status}`);
    }

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data
      .filter(msg => msg.role === 'assistant')
      .sort((a, b) => b.created_at - a.created_at)[0];

    if (!assistantMessage) {
      throw new Error('No assistant response found');
    }

    const responseText = assistantMessage.content[0].text.value;
    log('🤖', `Assistant response: ${responseText.substring(0, 200)}...`);

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

// MAIN WEBHOOK HANDLER - Using working structure
app.post('/freshchat-webhook', async (req, res) => {
  log('📥', '═'.repeat(50));
  log('📥', 'WEBHOOK RECEIVED');
  log('📥', 'Full webhook body:', req.body);
  log('📥', '═'.repeat(50));

  // Immediately respond to Freshchat to avoid timeout
  res.status(200).json({ status: 'received' });

  try {
    let conversationId, messageContent, actorType;

    // Try multiple possible webhook structures
    if (req.body.data?.conversation_id) {
      conversationId = req.body.data.conversation_id;
      messageContent = req.body.data.message_parts?.[0]?.text?.content;
      actorType = req.body.actor?.type;
    }
    else if (req.body.conversation_id) {
      conversationId = req.body.conversation_id;
      messageContent = req.body.message_parts?.[0]?.text?.content;
      actorType = req.body.actor_type;
    }
    else if (req.body.action === 'onMessageCreate' && req.body.data) {
      conversationId = req.body.data.conversationId;
      messageContent = req.body.data.messageParts?.[0]?.text?.content;
      actorType = req.body.data.actorType;
    }
    // New structure from webhook logs
    else if (req.body.action === 'message_create' && req.body.data?.message) {
      conversationId = req.body.data.message.conversation_id;
      messageContent = req.body.data.message.message_parts?.[0]?.text?.content;
      actorType = req.body.actor?.actor_type;
    }

    log('🔍', 'Extracted data:', {
      conversationId,
      messageContent: messageContent?.substring(0, 50),
      actorType,
      action: req.body.action
    });

    // Handle conversation assignment changes
    if (req.body.action === 'conversation_update' || req.body.action === 'conversation_assignment') {
      const convId = req.body.data?.conversation?.id || conversationId;
      const assignedAgentId = req.body.data?.conversation?.assigned_agent_id;
      
      if (convId && assignedAgentId === BOT_AGENT_ID && escalatedConversations.has(convId)) {
        log('🔄', `Conversation ${convId} returned to bot`);
        returnToBot(convId).catch(err => log('❌', 'Return to bot failed:', err.message));
      }
      return;
    }

    // Handle manager resolution messages
    if (req.body.action === 'message_create' && actorType === 'agent') {
      const agentId = req.body.actor?.actor_id;
      
      if (conversationId && messageContent && agentId && agentId !== BOT_AGENT_ID) {
        if (escalatedConversations.has(conversationId)) {
          const resolutionKeywords = [
            'resolved', 'handled', 'done', 'completed', 'sorted', 'fixed',
            'all set', 'back to bot', 'return to bot'
          ];
          
          const hasResolution = resolutionKeywords.some(keyword => 
            messageContent.toLowerCase().includes(keyword)
          );
          
          if (hasResolution) {
            log('✅', `Manager indicated resolution - returning ${conversationId} to bot`);
            returnToBot(conversationId).catch(err => log('❌', 'Return failed:', err.message));
          }
        }
      }
      return;
    }

    // Validate we have required data for user messages
    if (!conversationId || !messageContent) {
      log('❌', 'Missing conversationId or messageContent');
      return;
    }

    // Only process user messages
    if (actorType !== 'user' && actorType !== 'customer') {
      log('⚠️', `Ignoring non-user message from actorType: ${actorType}`);
      return;
    }

    log('💬', `Processing user message: "${messageContent}"`);

    // Check if conversation is with human
    const isWithHuman = await isConversationWithHuman(conversationId);
    
    if (isWithHuman) {
      log('🛑', 'STOPPING: Conversation is with human agent - bot will NOT respond');
      return;
    }

    // Assign conversation to bot first
    await assignConversationToBot(conversationId);

    // Get existing thread or null
    let threadId = conversationThreads.get(conversationId);
    
    const { response, threadId: newThreadId, needsEscalation } = 
      await getAssistantResponse(messageContent, threadId);

    conversationThreads.set(conversationId, newThreadId);

    // Send the response to Freshchat
    await sendFreshchatMessage(conversationId, response);

    if (needsEscalation) {
      log('🚨', 'Escalating to human agent');
      await escalateToHuman(conversationId);
    }

    log('✅', 'Message processing completed successfully');

  } catch (error) {
    log('💥', 'Webhook processing error:', error.message);
    log('💥', 'Error stack:', error.stack);
  }
});

// Test endpoint
app.post('/test-webhook', async (req, res) => {
  const { conversationId, message } = req.body;
  
  if (!conversationId || !message) {
    return res.status(400).json({ error: 'Missing conversationId or message' });
  }

  try {
    log('🧪', 'TEST: Simulating webhook');
    
    const isWithHuman = await isConversationWithHuman(conversationId);
    
    if (isWithHuman) {
      return res.json({
        success: false,
        message: 'Conversation is with human agent',
        conversationId
      });
    }
    
    await assignConversationToBot(conversationId);
    
    let threadId = conversationThreads.get(conversationId);
    const { response, needsEscalation } = await getAssistantResponse(message, threadId);
    
    await sendFreshchatMessage(conversationId, response);
    
    if (needsEscalation) {
      await escalateToHuman(conversationId);
    }
    
    res.json({ 
      success: true, 
      conversationId, 
      response: response.substring(0, 100) + '...',
      escalated: needsEscalation
    });
    
  } catch (error) {
    log('❌', 'Test failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Reset escalation
app.post('/reset-escalation/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  
  escalatedConversations.delete(conversationId);
  conversationThreads.delete(conversationId);
  
  log('🔄', `Reset escalation for conversation: ${conversationId}`);
  
  res.json({
    success: true,
    message: 'Escalation reset - bot can respond again',
    conversation_id: conversationId
  });
});

// Manually return to bot
app.post('/return-to-bot/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  
  try {
    const success = await returnToBot(conversationId);
    
    res.json({
      success,
      message: success ? 'Conversation returned to bot' : 'Failed to return',
      conversation_id: conversationId
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      conversation_id: conversationId
    });
  }
});

// View escalated conversations
app.get('/escalated', (req, res) => {
  res.json({
    escalated_conversations: Array.from(escalatedConversations),
    count: escalatedConversations.size,
    active_threads: conversationThreads.size
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    version: '8.0.0',
    timestamp: new Date().toISOString(),
    config: {
      freshchat_api_url: WORKING_API_URL,
      has_api_key: !!FRESHCHAT_API_KEY,
      has_openai_key: !!OPENAI_API_KEY,
      has_assistant_id: !!ASSISTANT_ID,
      has_bot_agent_id: !!BOT_AGENT_ID,
      has_human_agent_id: !!HUMAN_AGENT_ID
    },
    stats: {
      activeThreads: conversationThreads.size,
      escalatedConversations: escalatedConversations.size,
      uptime: process.uptime()
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Freshchat-OpenAI Integration',
    version: '8.0.0',
    status: 'running',
    endpoints: {
      webhook: 'POST /freshchat-webhook',
      test: 'POST /test-webhook (body: {conversationId, message})',
      reset_escalation: 'POST /reset-escalation/:conversationId',
      return_to_bot: 'POST /return-to-bot/:conversationId',
      escalated: 'GET /escalated',
      health: 'GET /health'
    },
    features: [
      'Auto-escalation to human agents',
      'Auto-return to bot on resolution',
      'Conversation thread persistence',
      'Multiple webhook format support'
    ]
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('🚀 Server started on port', PORT);
  console.log('📍 Webhook URL: POST /freshchat-webhook');
  console.log('🧪 Test URL: POST /test-webhook');
  console.log('❤️  Health: GET /health');
  console.log('✨ Ready to receive webhooks!');
});
