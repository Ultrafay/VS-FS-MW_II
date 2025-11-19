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
const HUMAN_AGENT_ID = process.env.HUMAN_AGENT_ID; // ADD THIS TO .env

// Validate environment variables
console.log('\n' + '='.repeat(70));
console.log('🔍 Configuration Check:');
console.log('='.repeat(70));
console.log('FRESHCHAT_API_KEY:', FRESHCHAT_API_KEY ? '✅ Set' : '❌ Missing');
console.log('FRESHCHAT_API_URL:', FRESHCHAT_API_URL);
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
  apiKey: OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID
});

// Store conversation threads
const conversationThreads = new Map();

// Store conversations that have been escalated (bot should NOT respond)
const escalatedConversations = new Set();

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function stripCitations(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let cleaned = text;

  const inlinePatterns = [
    /\[\^\d+\^\]/g,                  // OpenAI footnote markers like [^1^]
    /\[\d+\]/g,                      // Simple numeric citations like [1]
    /【\d+(?::\d+)?(?:†[^】]*)?】/g,   // Retrieval style citations (incl. section ids)
    /\(Source:[^)]+\)/gi             // Parenthetical source notes
  ];

  inlinePatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });

  // Remove footnote sections that may be appended at the end
  cleaned = cleaned.replace(/^\s*\[\^\d+\^\]:.*$/gm, '');
  cleaned = cleaned.replace(/^\s*【\d+(?::\d+)?(?:†[^】]*)?】.*$/gm, '');

  // Collapse redundant whitespace introduced by removals
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  cleaned = cleaned.replace(/\s+\n/g, '\n').trim();

  return cleaned;
}

function formatForWhatsApp(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let formatted = text.trim();

  // Remove markdown emphasis markers that WhatsApp may not render
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '$1');
  formatted = formatted.replace(/\*(.*?)\*/g, '$1');
  formatted = formatted.replace(/__(.*?)__/g, '$1');
  formatted = formatted.replace(/_(.*?)_/g, '$1');
  formatted = formatted.replace(/`([^`]+)`/g, '$1');

  // Convert headings to uppercase lines for clearer separation
  formatted = formatted.replace(/^#+\s*(.*)$/gm, (_, title) => title.toUpperCase());

  // Normalize bullet symbols
  formatted = formatted.replace(/^[\u2022•▪◦]\s*/gm, '- ');

  // Collapse excessive blank lines
  formatted = formatted.replace(/\n{3,}/g, '\n\n');

  // Trim residual whitespace around lines
  formatted = formatted
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();

  return formatted;
}

// Check if conversation is assigned to human agent
async function isConversationWithHuman(conversationId) {
  try {
    const response = await axios.get(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
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
    
    log('🔍', `Conversation ${conversationId} assigned to agent: ${assignedAgentId}`);
    log('🤖', `Bot agent ID: ${BOT_AGENT_ID}`);
    log('👤', `Human agent ID: ${HUMAN_AGENT_ID}`);

    // If assigned to human agent OR not assigned to bot, consider it "with human"
    if (assignedAgentId && assignedAgentId !== BOT_AGENT_ID) {
      log('👨‍💼', `Conversation is with human agent (${assignedAgentId})`);
      return true;
    }

    // If conversation is in escalated list
    if (escalatedConversations.has(conversationId)) {
      log('🚨', 'Conversation is in escalated list');
      return true;
    }

    log('🤖', 'Conversation is still with bot');
    return false;

  } catch (error) {
    log('❌', 'Error checking conversation assignment:', error.message);
    // If we can't check, assume it's safe to respond
    return false;
  }
}

// Assign conversation to human agent (ESCALATION)
async function escalateToHuman(conversationId) {
  try {
    if (!HUMAN_AGENT_ID) {
      log('⚠️', 'No HUMAN_AGENT_ID set, cannot escalate');
      return false;
    }

    log('🚨', `Escalating conversation ${conversationId} to human agent ${HUMAN_AGENT_ID}`);

    // Reassign conversation to human agent
    const response = await axios.put(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
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
    log('📋', 'Response:', response.data);

    // Add to escalated list so bot stops responding
    escalatedConversations.add(conversationId);

    // Send notification message
    await sendFreshchatMessage(
      conversationId,
      "I'm connecting you with a team member who will be with you shortly. 👋"
    );

    // Remove thread to start fresh with human
    conversationThreads.delete(conversationId);
    log('🗑️', `Removed thread for conversation ${conversationId}`);

    return true;

  } catch (error) {
    log('❌', 'Failed to escalate conversation:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    return false;
  }
}

// Return conversation back to bot (DE-ESCALATION)
async function returnToBot(conversationId) {
  try {
    if (!BOT_AGENT_ID) {
      log('⚠️', 'No BOT_AGENT_ID set, cannot return to bot');
      return false;
    }

    log('🔄', `Returning conversation ${conversationId} to bot agent ${BOT_AGENT_ID}`);

    // Reassign conversation to bot agent
    const response = await axios.put(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
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

    log('✅', `Conversation reassigned to bot agent`);
    log('📋', 'Response:', response.data);

    // Remove from escalated list so bot can respond again
    escalatedConversations.delete(conversationId);
    log('✅', `Removed conversation ${conversationId} from escalated list`);

    // Send welcome back message
    await sendFreshchatMessage(
      conversationId,
      "I'm back! How can I help you today? 😊"
    );

    return true;

  } catch (error) {
    log('❌', 'Failed to return conversation to bot:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    return false;
  }
}

// Send message to Freshchat
async function sendFreshchatMessage(conversationId, message) {
  try {
    log('📤', `Sending message to conversation: ${conversationId}`);
    log('📝', `Message: ${message.substring(0, 100)}...`);
    
    const payload = BOT_AGENT_ID ? {
      message_parts: [{ text: { content: message } }],
      message_type: 'normal',
      actor_type: 'agent',
      actor_id: BOT_AGENT_ID
    } : {
      message_parts: [{ text: { content: message } }],
      message_type: 'normal',
      actor_type: 'agent'
    };

    const response = await axios.post(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    log('✅', `Message sent successfully!`);
    return response.data;
    
  } catch (error) {
    log('❌', 'Failed to send message:', {
      status: error.response?.status,
      error: error.response?.data || error.message
    });
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

    // Check for escalation keywords
    const escalationKeywords = [
      'connect you with my manager',
      'connect you with a manager',
      'speak to my manager',
      'talk to my manager',
      'escalate',
      'human agent',
      'real person'
    ];

    const needsEscalation = escalationKeywords.some(keyword => 
      responseText.toLowerCase().includes(keyword.toLowerCase())
    );

    if (needsEscalation) {
      log('🚨', 'ESCALATION KEYWORD DETECTED in response!');
    }

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

    // CRITICAL CHECK: Is this conversation with a human?
    const isWithHuman = await isConversationWithHuman(conversationId);
    
    if (isWithHuman) {
      log('🛑', '═'.repeat(70));
      log('🛑', 'STOPPING: Conversation is with human agent');
      log('🛑', 'Bot will NOT respond');
      log('🛑', '═'.repeat(70));
      return; // EXIT - Don't respond
    }

    log('🤖', 'Conversation is with bot - proceeding with AI response');
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
    const cleanedResponse = formatForWhatsApp(stripCitations(response));
    await sendFreshchatMessage(conversationId, cleanedResponse);

    // Handle escalation if needed
    if (needsEscalation) {
      log('🚨', '═'.repeat(70));
      log('🚨', 'ESCALATION TRIGGERED!');
      log('🚨', '═'.repeat(70));
      
      const escalated = await escalateToHuman(conversationId);
      
      if (escalated) {
        log('✅', 'Successfully escalated to human agent');
      } else {
        log('❌', 'Escalation failed - bot will continue');
      }
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
      
      // Escalate on error
      if (HUMAN_AGENT_ID) {
        await escalateToHuman(conversationId);
      }
    } catch (fallbackError) {
      log('❌', 'Failed to send error message:', fallbackError.message);
    }
  }
}

// Webhook handler for Freshchat
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
      actor_id: actor?.actor_id,
      has_data: !!data,
      has_message: !!data?.message,
      has_conversation: !!data?.conversation
    });
    
    // Handle conversation assignment changes (return to bot)
    if (action === 'conversation_update' && data?.conversation) {
      const conversationId = data.conversation.id || data.conversation.conversation_id;
      const assignedAgentId = data.conversation.assigned_agent_id;
      
      if (conversationId && assignedAgentId) {
        log('🔄', `Conversation ${conversationId} assignment changed to: ${assignedAgentId}`);
        
        // If conversation was escalated and is now assigned to bot, return to bot
        if (escalatedConversations.has(conversationId) && assignedAgentId === BOT_AGENT_ID) {
          log('✅', 'Detected conversation returned to bot - removing from escalated list');
          escalatedConversations.delete(conversationId);
          log('🤖', `Conversation ${conversationId} is now active with bot`);
        }
      }
    }
    
    // Handle manager messages with resolution keywords
    if (action === 'message_create' && actor?.actor_type === 'agent') {
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      const agentId = actor?.actor_id;
      
      // Check if this is a manager message (not bot) and conversation is escalated
      if (conversationId && messageContent && agentId && agentId !== BOT_AGENT_ID) {
        if (escalatedConversations.has(conversationId)) {
          // Check for resolution keywords
          const resolutionKeywords = [
            'it seems like you are unavailable at the moment. I am closing the chat for now',
    
            'back to bot',
            'return to bot',
            'handing back',
          ];
          
          const messageLower = messageContent.toLowerCase();
          const hasResolutionKeyword = resolutionKeywords.some(keyword => 
            messageLower.includes(keyword)
          );
          
          if (hasResolutionKeyword) {
            log('✅', `Manager indicated resolution - returning conversation ${conversationId} to bot`);
            returnToBot(conversationId)
              .catch(err => log('❌', 'Failed to return to bot:', err.message));
          }
        }
      }
    }
    
    // Handle user messages (message_create event from users)
    if (action === 'message_create' && actor?.actor_type === 'user') {
      
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      
      log('🔍', 'Message data:', {
        conversationId,
        messageContent: messageContent?.substring(0, 100),
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
      
    } else if (action !== 'conversation_update' && action !== 'message_create') {
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
    
    // Check if with human
    const isWithHuman = await isConversationWithHuman(conversation_id);
    
    if (isWithHuman) {
      return res.json({
        success: false,
        message: 'Conversation is with human agent - bot will not respond',
        conversation_id
      });
    }

    // Get OpenAI response
    let threadId = conversationThreads.get(conversation_id);
    const { response, threadId: newThreadId, needsEscalation } = 
      await getAssistantResponse(message, threadId);
    
    conversationThreads.set(conversation_id, newThreadId);
    
    // Send to Freshchat
    const cleanedResponse = formatForWhatsApp(stripCitations(response));
    await sendFreshchatMessage(conversation_id, cleanedResponse);
    
    // Handle escalation
    if (needsEscalation) {
      await escalateToHuman(conversation_id);
    }
    
    res.json({
      success: true,
      conversation_id,
      response: response.substring(0, 200) + '...',
      thread_id: newThreadId,
      escalated: needsEscalation
    });
    
  } catch (error) {
    log('❌', 'Test failed:', error.message);
    res.status(500).json({
      error: error.message,
      conversation_id
    });
  }
});

// Reset escalation (for testing)
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

// Manually return conversation to bot
app.post('/return-to-bot/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  
  try {
    const success = await returnToBot(conversationId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Conversation returned to bot',
        conversation_id: conversationId
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to return conversation to bot',
        conversation_id: conversationId
      });
    }
  } catch (error) {
    log('❌', 'Error returning to bot:', error.message);
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
    version: '7.0.0',
    timestamp: new Date().toISOString(),
    config: {
      freshchat_api_url: FRESHCHAT_API_URL,
      has_api_key: !!FRESHCHAT_API_KEY,
      has_openai_key: !!OPENAI_API_KEY,
      has_assistant_id: !!ASSISTANT_ID,
      has_bot_agent_id: !!BOT_AGENT_ID,
      has_human_agent_id: !!HUMAN_AGENT_ID
    },
    stats: {
      activeThreads: conversationThreads.size,
      escalatedConversations: escalatedConversations.size
    }
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
      BOT_AGENT_ID: BOT_AGENT_ID || 'Not set',
      HUMAN_AGENT_ID: HUMAN_AGENT_ID || 'Not set'
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
  } catch (error) {
    results.tests.freshchat = `❌ Failed: ${error.response?.status} - ${error.message}`;
  }

  res.json(results);
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Freshchat-OpenAI Integration',
    version: '7.0.0',
    status: 'running',
    endpoints: {
      webhook: 'POST /freshchat-webhook',
      test_message: 'POST /test-message (body: {conversation_id, message})',
      reset_escalation: 'POST /reset-escalation/:conversationId',
      return_to_bot: 'POST /return-to-bot/:conversationId',
      escalated: 'GET /escalated',
      health: 'GET /health',
      test_config: 'GET /test-config'
    },
    features: {
      auto_escalation: 'Bot escalates to human when needed',
      auto_return: 'Conversation returns to bot when manager resolves or reassigns',
      resolution_keywords: 'Detects manager messages with resolution keywords',
      whatsapp_formatting: 'Messages formatted for WhatsApp display'
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
  console.log(`🔄 Reset: POST /reset-escalation/:conversationId`);
  console.log(`↩️  Return to Bot: POST /return-to-bot/:conversationId`);
  console.log(`📊 Escalated: GET /escalated`);
  console.log(`❤️  Health: GET /health`);
  console.log(`🔧 Config: GET /test-config`);
  console.log('='.repeat(70));
  console.log('✨ Features: Auto-escalation & Auto-return to bot');
  console.log('='.repeat(70) + '\n');
});
