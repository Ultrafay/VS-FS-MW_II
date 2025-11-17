require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());

// Configuration
const FRESHCHAT_API_KEY = process.env.FRESHCHAT_API_KEY;
const FRESHCHAT_API_URL = process.env.FRESHCHAT_API_URL || 'https://api.freshchat.com/v2';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const BOT_AGENT_ID = process.env.FRESHCHAT_BOT_AGENT_ID;
const HUMAN_AGENT_ID = process.env.HUMAN_AGENT_ID;
const THREADS_FILE = path.join(__dirname, 'threads.json');

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

// Store conversation threads with timestamps
const conversationThreads = new Map();
const threadTimestamps = new Map();

// Store conversations that have been escalated (bot should NOT respond)
const escalatedConversations = new Set();

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// ==================== THREAD PERSISTENCE ====================

// Save threads to disk
async function saveThreads() {
  try {
    const threadsData = {
      threads: Object.fromEntries(conversationThreads),
      timestamps: Object.fromEntries(threadTimestamps),
      escalated: Array.from(escalatedConversations)
    };
    await fs.writeFile(THREADS_FILE, JSON.stringify(threadsData, null, 2));
    log('💾', `Saved ${conversationThreads.size} threads to disk`);
  } catch (error) {
    log('❌', 'Error saving threads:', error.message);
  }
}

// Load threads from disk
async function loadThreads() {
  try {
    const data = await fs.readFile(THREADS_FILE, 'utf8');
    const { threads, timestamps, escalated } = JSON.parse(data);
    
    Object.entries(threads || {}).forEach(([k, v]) => conversationThreads.set(k, v));
    Object.entries(timestamps || {}).forEach(([k, v]) => threadTimestamps.set(k, v));
    (escalated || []).forEach(convId => escalatedConversations.add(convId));
    
    log('✅', `Loaded ${conversationThreads.size} threads, ${escalatedConversations.size} escalated from disk`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      log('ℹ️', 'No existing threads file found, starting fresh');
    } else {
      log('❌', 'Error loading threads:', error.message);
    }
  }
}

// Update thread timestamp
function updateThreadTimestamp(conversationId) {
  threadTimestamps.set(conversationId, Date.now());
}

// Cleanup old threads (older than 7 days)
function cleanupOldThreads() {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let cleaned = 0;
  
  for (const [conversationId, timestamp] of threadTimestamps.entries()) {
    if (timestamp < sevenDaysAgo) {
      conversationThreads.delete(conversationId);
      threadTimestamps.delete(conversationId);
      escalatedConversations.delete(conversationId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    log('🧹', `Cleaned up ${cleaned} old threads`);
    saveThreads(); // Persist cleanup
  }
}

// ==================== FORMATTING HELPERS ====================

function stripCitations(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let cleaned = text;

  const inlinePatterns = [
    /\[\^\d+\^\]/g,
    /\[\d+\]/g,
    /【\d+(?::\d+)?(?:†[^】]*)?】/g,
    /\(Source:[^)]+\)/gi
  ];

  inlinePatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });

  cleaned = cleaned.replace(/^\s*\[\^\d+\^\]:.*$/gm, '');
  cleaned = cleaned.replace(/^\s*【\d+(?::\d+)?(?:†[^】]*)?】.*$/gm, '');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  cleaned = cleaned.replace(/\s+\n/g, '\n').trim();

  return cleaned;
}

function formatForWhatsApp(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let formatted = text.trim();

  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '$1');
  formatted = formatted.replace(/\*(.*?)\*/g, '$1');
  formatted = formatted.replace(/__(.*?)__/g, '$1');
  formatted = formatted.replace(/_(.*?)_/g, '$1');
  formatted = formatted.replace(/`([^`]+)`/g, '$1');
  formatted = formatted.replace(/^#+\s*(.*)$/gm, (_, title) => title.toUpperCase());
  formatted = formatted.replace(/^[\u2022•▪◦]\s*/gm, '- ');
  formatted = formatted.replace(/\n{3,}/g, '\n\n');

  formatted = formatted
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();

  return formatted;
}

// ==================== CONVERSATION MANAGEMENT ====================

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
    
    log('🔍', `Conversation ${conversationId} assigned to agent: ${assignedAgentId || 'none'}`);

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
      log('⚠️', 'No HUMAN_AGENT_ID set, marking as escalated but not reassigning');
      escalatedConversations.add(conversationId);
      await saveThreads();
      return true;
    }

    log('🚨', `Escalating conversation ${conversationId} to human agent ${HUMAN_AGENT_ID}`);

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

    // Add to escalated list so bot stops responding
    escalatedConversations.add(conversationId);
    await saveThreads();

    // Send notification message
    await sendFreshchatMessage(
      conversationId,
      "I'm connecting you with a team member who will be with you shortly. 👋"
    );

    // Keep thread for conversation history
    log('ℹ️', `Keeping thread for conversation ${conversationId} for when it returns`);

    return true;

  } catch (error) {
    log('❌', 'Failed to escalate conversation:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    
    // Still mark as escalated to prevent bot from responding
    escalatedConversations.add(conversationId);
    await saveThreads();
    return false;
  }
}

// Return conversation back to bot (DE-ESCALATION)
async function returnToBot(conversationId) {
  try {
    log('🔄', `Returning conversation ${conversationId} to bot`);

    if (BOT_AGENT_ID) {
      // Reassign conversation to bot agent
      await axios.put(
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
      log('✅', `Conversation reassigned to bot agent ${BOT_AGENT_ID}`);
    }

    // Remove from escalated list so bot can respond again
    escalatedConversations.delete(conversationId);
    await saveThreads();
    log('✅', `Removed conversation ${conversationId} from escalated list`);

    // Check if we have an existing thread
    const threadId = conversationThreads.get(conversationId);
    
    if (threadId) {
      log('♻️', `Found existing thread ${threadId} - conversation history preserved`);
    } else {
      log('🆕', 'No existing thread - will create new one on next message');
    }

    // Send welcome back message
    await sendFreshchatMessage(
      conversationId,
      "I'm back! How can I help you today? 😊"
    );

    return true;

  } catch (error) {
    log('❌', 'Failed to return conversation to bot:', error.message);
    
    // Still try to remove from escalated list
    escalatedConversations.delete(conversationId);
    await saveThreads();
    return false;
  }
}

// ==================== FRESHCHAT API ====================

// Send message to Freshchat
async function sendFreshchatMessage(conversationId, message, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log('📤', `Sending message to ${conversationId} (Attempt ${attempt}/${retries})`);
      log('📝', `Message: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
      
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
      log('❌', `Send failed (Attempt ${attempt}/${retries}):`, {
        status: error.response?.status,
        error: error.response?.data?.message || error.message
      });
      
      // Retry on network errors or 5xx errors
      if (attempt < retries && (!error.response || error.response.status >= 500)) {
        const delay = 1000 * attempt;
        log('⏳', `Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
}

// ==================== OPENAI ASSISTANT ====================

// Get response from OpenAI Assistant
async function getAssistantResponse(userMessage, conversationId) {
  try {
    log('🤖', `Getting OpenAI response for: "${userMessage.substring(0, 100)}..."`);
    
    let threadId = conversationThreads.get(conversationId);
    let thread;
    
    if (!threadId) {
      thread = await openai.beta.threads.create();
      threadId = thread.id;
      conversationThreads.set(conversationId, threadId);
      updateThreadTimestamp(conversationId);
      log('🆕', `Created new thread: ${threadId} for conversation ${conversationId}`);
    } else {
      thread = { id: threadId };
      updateThreadTimestamp(conversationId);
      log('♻️', `Using existing thread: ${threadId} for conversation ${conversationId}`);
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

// ==================== MESSAGE PROCESSING ====================

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

    // Get OpenAI response
    const { response, threadId, needsEscalation } = 
      await getAssistantResponse(messageContent, conversationId);

    // Save threads after successful processing
    await saveThreads();

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

// ==================== WEBHOOK HANDLER ====================

// Webhook handler for Freshchat
app.post('/freshchat-webhook', async (req, res) => {
  // IMMEDIATELY respond to avoid timeout
  res.status(200).json({ success: true });
  
  log('📥', '═'.repeat(70));
  log('📥', 'WEBHOOK RECEIVED');
  log('📥', '═'.repeat(70));
  
  try {
    const { actor, action, data } = req.body;
    
    log('📋', 'Webhook details:', {
      action,
      actor_type: actor?.actor_type,
      actor_id: actor?.actor_id,
      has_data: !!data
    });
    
    // ============ HANDLE CONVERSATION ASSIGNMENT CHANGES ============
    if (action === 'conversation_assignment' || 
        (action === 'conversation_update' && data?.conversation)) {
      
      const conversationId = data?.conversation?.id || 
                            data?.conversation?.conversation_id ||
                            data?.assignment?.conversation_id;
      const assignedAgentId = data?.conversation?.assigned_agent_id ||
                             data?.assignment?.assigned_agent_id;
      
      if (conversationId && assignedAgentId !== undefined) {
        log('🔄', `Conversation ${conversationId} assignment changed to: ${assignedAgentId || 'unassigned'}`);
        
        // If assigned to bot, remove from escalated list
        if (assignedAgentId === BOT_AGENT_ID || 
            (!assignedAgentId && escalatedConversations.has(conversationId))) {
          
          log('🤖', 'Detected conversation returned to bot');
          escalatedConversations.delete(conversationId);
          await saveThreads();
          
          // Send welcome back message
          returnToBot(conversationId)
            .catch(err => log('❌', 'Failed to return to bot:', err.message));
        }
        // If assigned to human, add to escalated list
        else if (assignedAgentId && assignedAgentId !== BOT_AGENT_ID) {
          log('👨‍💼', 'Conversation assigned to human agent');
          escalatedConversations.add(conversationId);
          await saveThreads();
        }
      }
    }
    
    // ============ HANDLE MANAGER MESSAGES WITH RESOLUTION KEYWORDS ============
    if (action === 'message_create' && actor?.actor_type === 'agent') {
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      const agentId = actor?.actor_id;
      
      // Check if this is a manager message (not bot) and conversation is escalated
      if (conversationId && messageContent && agentId && agentId !== BOT_AGENT_ID) {
        if (escalatedConversations.has(conversationId)) {
          
          const resolutionKeywords = [
            'resolved', 'handled', 'done', 'completed', 'sorted', 'fixed',
            'all set', 'taken care of', 'back to bot', 'return to bot',
            'handing back', 'transferring back'
          ];
          
          const messageLower = messageContent.toLowerCase();
          const hasResolutionKeyword = resolutionKeywords.some(keyword => 
            messageLower.includes(keyword)
          );
          
          if (hasResolutionKeyword) {
            log('✅', `Manager indicated resolution - returning ${conversationId} to bot`);
            returnToBot(conversationId)
              .catch(err => log('❌', 'Failed to return to bot:', err.message));
          }
        }
      }
    }
    
    // ============ HANDLE USER MESSAGES ============
    if (action === 'message_create' && actor?.actor_type === 'user') {
      
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      
      if (!conversationId || !messageContent) {
        log('⚠️', 'Missing conversation ID or message content');
        return;
      }

      log('💬', `User message in ${conversationId}: "${messageContent.substring(0, 100)}..."`);

      // Process asynchronously (don't wait)
      processMessage(conversationId, messageContent)
        .catch(err => log('❌', 'Async processing error:', err.message));
      
    } else if (action !== 'conversation_update' && 
               action !== 'conversation_assignment' &&
               action !== 'message_create') {
      log('ℹ️', `Ignoring webhook: action=${action}, actor_type=${actor?.actor_type}`);
    }
    
  } catch (error) {
    log('💥', 'Webhook processing error:', error.message);
  }
});

// ==================== TEST & MANAGEMENT ENDPOINTS ====================

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
    const isWithHuman = await isConversationWithHuman(conversation_id);
    
    if (isWithHuman) {
      return res.json({
        success: false,
        message: 'Conversation is with human agent - bot will not respond',
        conversation_id
      });
    }

    const { response, threadId, needsEscalation } = 
      await getAssistantResponse(message, conversation_id);
    
    await saveThreads();
    
    const cleanedResponse = formatForWhatsApp(stripCitations(response));
    await sendFreshchatMessage(conversation_id, cleanedResponse);
    
    if (needsEscalation) {
      await escalateToHuman(conversation_id);
    }
    
    res.json({
      success: true,
      conversation_id,
      response: response.substring(0, 200) + '...',
      thread_id: threadId,
      escalated: needsEscalation
    });
    
  } catch (error) {
    res.status(500).json({
      error: error.message,
      conversation_id
    });
  }
});

// Reset escalation
app.post('/reset-escalation/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  
  escalatedConversations.delete(conversationId);
  conversationThreads.delete(conversationId);
  threadTimestamps.delete(conversationId);
  await saveThreads();
  
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

// Debug threads
app.get('/debug/threads', (req, res) => {
  const threads = Array.from(conversationThreads.entries()).map(([convId, threadId]) => ({
    conversationId: convId,
    threadId: threadId,
    lastActivity: threadTimestamps.get(convId) 
      ? new Date(threadTimestamps.get(convId)).toISOString() 
      : 'unknown',
    isEscalated: escalatedConversations.has(convId)
  }));
  
  res.json({
    totalThreads: threads.length,
    escalatedCount: escalatedConversations.size,
    threads: threads
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    version: '8.0.0',
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
      escalatedConversations: escalatedConversations.size,
      uptime: process.uptime()
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
      BOT_AGENT_ID: BOT_AGENT_ID || '
