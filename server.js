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
const FRESHCHAT_API_URL = 'https://api.freshchat.com/v2';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const FRESHCHAT_WEBHOOK_SECRET = process.env.FRESHCHAT_WEBHOOK_SECRET; // Optional
const THREADS_FILE = path.join(__dirname, 'threads.json');

// Validate environment variables
if (!FRESHCHAT_API_KEY || !OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error('❌ Missing required environment variables!');
  console.error('Please set: FRESHCHAT_API_KEY, OPENAI_API_KEY, ASSISTANT_ID');
  process.exit(1);
}

const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID, // Optional
  project: process.env.OPENAI_PROJECT_ID  // Optional
});

// Store conversation threads with timestamps
const conversationThreads = new Map();
const threadTimestamps = new Map();

// Logging helper
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
      timestamps: Object.fromEntries(threadTimestamps)
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
    const { threads, timestamps } = JSON.parse(data);
    
    Object.entries(threads).forEach(([k, v]) => conversationThreads.set(k, v));
    Object.entries(timestamps || {}).forEach(([k, v]) => threadTimestamps.set(k, v));
    
    log('✅', `Loaded ${conversationThreads.size} threads from disk`);
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

// Get thread ID for conversation
function getThreadId(conversationId) {
  return conversationThreads.get(conversationId);
}

// Set thread ID for conversation
function setThreadId(conversationId, threadId) {
  conversationThreads.set(conversationId, threadId);
  updateThreadTimestamp(conversationId);
}

// Cleanup old threads (older than 7 days)
function cleanupOldThreads() {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let cleaned = 0;
  
  for (const [conversationId, timestamp] of threadTimestamps.entries()) {
    if (timestamp < sevenDaysAgo) {
      conversationThreads.delete(conversationId);
      threadTimestamps.delete(conversationId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    log('🧹', `Cleaned up ${cleaned} old threads`);
    saveThreads(); // Persist cleanup
  }
}

// ==================== FRESHCHAT API ====================

// Send message to Freshchat with retry logic
async function sendFreshchatMessage(conversationId, message, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log('📤', `Sending message to conversation: ${conversationId} (Attempt ${attempt}/${retries})`);
      log('📝', `Message: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
      
      const payload = {
        messages: [{
          message_parts: [{
            text: {
              content: message
            }
          }],
          message_type: 'normal',
          actor_type: 'system'
        }]
      };
      
      const response = await axios.post(
        `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10 second timeout
        }
      );
      
      log('✅', `Message sent successfully to conversation ${conversationId}`);
      return response.data;
      
    } catch (error) {
      log('❌', `Error sending message (Attempt ${attempt}/${retries})`);
      log('❌', `Status: ${error.response?.status}, Message: ${error.message}`);
      
      // Try alternative format on 400 error
      if (error.response?.status === 400 && attempt === 1) {
        log('🔄', 'Trying alternative message format...');
        return await sendFreshchatMessageAlt(conversationId, message);
      }
      
      // Retry on network errors or 5xx errors
      if (attempt < retries && (!error.response || error.response.status >= 500)) {
        const delay = 1000 * attempt; // Exponential backoff
        log('⏳', `Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
}

// Alternative message format
async function sendFreshchatMessageAlt(conversationId, message) {
  try {
    const payload = {
      message_type: 'normal',
      message_parts: [{
        text: {
          content: message
        }
      }],
      actor_type: 'system'
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
    
    log('✅', `Message sent with alternative format`);
    return response.data;
  } catch (error) {
    log('❌', `Alternative format also failed:`, error.response?.data);
    throw error;
  }
}

// Assign conversation to human agent
async function assignToHumanAgent(conversationId) {
  try {
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
    log('🚨', `Conversation ${conversationId} escalated to human agent`);
    return true;
  } catch (error) {
    log('❌', 'Error escalating to agent:', error.response?.data || error.message);
    throw error;
  }
}

// ==================== OPENAI ASSISTANT ====================

// Get response from OpenAI Assistant
async function getAssistantResponse(userMessage, conversationId) {
  try {
    let threadId = getThreadId(conversationId);
    let thread;
    
    if (!threadId) {
      thread = await openai.beta.threads.create();
      threadId = thread.id;
      setThreadId(conversationId, threadId);
      log('🆕', `New thread created: ${threadId} for conversation ${conversationId}`);
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

    log('⏳', 'Waiting for assistant response...');

    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds timeout

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;

      if (runStatus.status === 'failed' || runStatus.status === 'expired') {
        throw new Error(`Assistant run ${runStatus.status}: ${runStatus.last_error?.message || 'Unknown error'}`);
      }
      
      if (runStatus.status === 'requires_action') {
        log('⚠️', 'Assistant requires action - not yet implemented');
        throw new Error('Assistant requires action');
      }
    }

    if (attempts >= maxAttempts) {
      throw new Error('Assistant response timeout after 60 seconds');
    }

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data[0].content[0].text.value;

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
    }

    log('🤖', `Assistant response: ${cleanMessage.substring(0, 100)}${cleanMessage.length > 100 ? '...' : ''}`);
    if (needsEscalation) {
      log('🚨', `Escalation reason: ${escalationReason}`);
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

// ==================== MESSAGE PROCESSING ====================

// Process user message asynchronously
async function processMessageAsync(conversationId, messageContent) {
  try {
    log('🔄', `Processing message asynchronously for ${conversationId}`);

    const { response, threadId, needsEscalation, escalationReason } = 
      await getAssistantResponse(messageContent, conversationId);

    await sendFreshchatMessage(conversationId, response);

    if (needsEscalation) {
      log('🚨', `Escalating conversation ${conversationId}: ${escalationReason}`);
      await assignToHumanAgent(conversationId);
      await sendFreshchatMessage(
        conversationId, 
        'A team member will be with you shortly. Thank you for your patience!'
      );
    }

    // Save threads after successful processing
    await saveThreads();
    
    log('✅', `Message processing completed for ${conversationId}`);

  } catch (error) {
    log('❌', `Error processing message for ${conversationId}:`, error.message);
    
    // Send error message to user and escalate
    try {
      await sendFreshchatMessage(
        conversationId,
        "I'm having trouble processing your request right now. Let me connect you with a human agent."
      );
      await assignToHumanAgent(conversationId);
    } catch (fallbackError) {
      log('❌', 'Failed to send error message:', fallbackError.message);
    }
  }
}

// Handle conversation reassignment to bot
async function processReassignmentAsync(conversationId) {
  try {
    log('🤖', `Processing reassignment for conversation ${conversationId}`);
    
    const threadId = getThreadId(conversationId);
    
    if (threadId) {
      log('✅', `Found existing thread ${threadId} for conversation ${conversationId}`);
      const welcomeBackMessage = "I'm back to assist you! How can I help you today?";
      await sendFreshchatMessage(conversationId, welcomeBackMessage);
    } else {
      log('ℹ️', `No existing thread found for ${conversationId}, waiting for user message`);
    }
    
  } catch (error) {
    log('❌', `Error processing reassignment for ${conversationId}:`, error.message);
  }
}

// Log conversation state for debugging
function logConversationState(conversationId) {
  const threadId = getThreadId(conversationId);
  const timestamp = threadTimestamps.get(conversationId);
  
  log('📊', `Conversation State:`, {
    conversationId,
    hasThread: !!threadId,
    threadId: threadId || 'none',
    lastActivity: timestamp ? new Date(timestamp).toISOString() : 'never',
    totalActiveThreads: conversationThreads.size
  });
}

// ==================== WEBHOOK VERIFICATION ====================

function verifyFreshchatWebhook(req) {
  if (!FRESHCHAT_WEBHOOK_SECRET) {
    return true; // Skip verification if secret not configured
  }
  
  const signature = req.headers['x-freshchat-signature'];
  if (!signature) {
    log('⚠️', 'No webhook signature provided');
    return false;
  }
  
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha256', FRESHCHAT_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');
  
  return signature === hash;
}

// ==================== WEBHOOK ENDPOINTS ====================

// Main webhook endpoint - RESPONDS IMMEDIATELY
app.post('/freshchat-webhook', async (req, res) => {
  try {
    // Verify webhook signature (if configured)
    if (!verifyFreshchatWebhook(req)) {
      log('🚨', 'Invalid webhook signature!');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // RESPOND IMMEDIATELY to avoid timeout (within 3 seconds)
    res.status(200).json({ success: true, message: 'Webhook received' });
    
    log('📥', 'Webhook received and acknowledged');
    
    const { actor, action, data } = req.body;
    
    // Log webhook details
    log('📋', 'Webhook details:', {
      actor_type: actor?.actor_type,
      action: action,
      conversation_id: data?.message?.conversation_id || data?.conversation?.conversation_id,
      has_message: !!data?.message
    });
    
    // ============ HANDLE USER MESSAGES ============
    if (action === 'message_create' && actor?.actor_type === 'user') {
      
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      
      if (!conversationId || !messageContent) {
        log('⚠️', 'Missing conversation ID or message content');
        return;
      }

      log('💬', `User message in ${conversationId}: "${messageContent}"`);
      logConversationState(conversationId);

      // Process message ASYNCHRONOUSLY (don't wait)
      processMessageAsync(conversationId, messageContent)
        .catch(err => log('❌', 'Async processing error:', err.message));
    }
    
    // ============ HANDLE CONVERSATION REASSIGNMENT ============
    else if (action === 'conversation_status_update' || 
             action === 'conversation_assignment_update' ||
             action === 'conversation_update') {
      
      const conversationId = data?.conversation?.conversation_id || data?.conversation_id;
      const status = data?.conversation?.status;
      const assignedAgentId = data?.conversation?.assigned_agent_id;
      const assignedGroupId = data?.conversation?.assigned_group_id;
      
      log('🔄', `Conversation update for ${conversationId}:`, {
        status,
        assignedAgentId,
        assignedGroupId
      });
      
      // Check if conversation is reassigned to bot
      // This happens when: no agent assigned OR assigned to bot group/agent
      const isReassignedToBot = !assignedAgentId || 
                                 assignedAgentId === 'bot' || 
                                 assignedAgentId === null ||
                                 (status === 'new' || status === 'assigned');
      
      if (isReassignedToBot && conversationId) {
        log('🤖', `Conversation ${conversationId} reassigned to bot`);
        logConversationState(conversationId);
        
        // Process reassignment ASYNCHRONOUSLY
        processReassignmentAsync(conversationId)
          .catch(err => log('❌', 'Reassignment processing error:', err.message));
      }
    }
    
    // ============ LOG OTHER WEBHOOK EVENTS FOR DEBUGGING ============
    else {
      log('ℹ️', `Webhook event (not processed): ${action} from ${actor?.actor_type}`);
      
      // Uncomment below to see all webhook data for debugging
      // log('🔍', 'Full webhook payload:', req.body);
    }
    
  } catch (error) {
    log('❌', 'Webhook error:', error.message);
    // Already responded, so just log the error
  }
});

// ==================== HEALTH & TEST ENDPOINTS ====================

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeThreads: conversationThreads.size,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
    }
  });
});

// Test configuration
app.get('/test', (req, res) => {
  res.status(200).json({
    status: 'Server running',
    version: '2.0.0',
    config: {
      freshchat: !!FRESHCHAT_API_KEY,
      openai: !!OPENAI_API_KEY,
      assistant: !!ASSISTANT_ID,
      webhookSecret: !!FRESHCHAT_WEBHOOK_SECRET
    },
    activeThreads: conversationThreads.size,
    timestamp: new Date().toISOString()
  });
});

// Debug endpoint to view active threads
app.get('/debug/threads', (req, res) => {
  const threads = Array.from(conversationThreads.entries()).map(([convId, threadId]) => ({
    conversationId: convId,
    threadId: threadId,
    lastActivity: threadTimestamps.get(convId) 
      ? new Date(threadTimestamps.get(convId)).toISOString() 
      : 'unknown'
  }));
  
  res.status(200).json({
    totalThreads: threads.length,
    threads: threads
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'Freshchat-OpenAI Integration Server',
    version: '2.0.0',
    endpoints: {
      webhook: 'POST /freshchat-webhook',
      health: 'GET /health',
      test: 'GET /test',
      debug: 'GET /debug/threads'
    },
    features: [
      'Persistent thread storage',
      'Auto-cleanup of old threads',
      'Webhook signature verification',
      'Conversation reassignment handling',
      'Retry logic with exponential backoff',
      'Memory leak prevention'
    ],
    status: 'running'
  });
});

// ==================== STARTUP & CLEANUP ====================

const PORT = process.env.PORT || 3000;

// Graceful shutdown handler
async function gracefulShutdown() {
  log('⚠️', 'Shutting down gracefully...');
  await saveThreads();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start server
app.listen(PORT, async () => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 Freshchat-OpenAI Integration Server Started (v2.0.0)');
  console.log('='.repeat(70));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Webhook: POST /freshchat-webhook`);
  console.log(`❤️  Health: GET /health`);
  console.log(`🧪 Test: GET /test`);
  console.log(`🐛 Debug: GET /debug/threads`);
  console.log('='.repeat(70));
  console.log('✨ New Features:');
  console.log('   • Persistent thread storage (survives restarts)');
  console.log('   • Handles conversation reassignment to bot');
  console.log('   • Auto-cleanup of threads older than 7 days');
  console.log('   • Retry logic with exponential backoff');
  console.log('   • Webhook signature verification');
  console.log('='.repeat(70) + '\n');
  
  // Load existing threads from disk
  await loadThreads();
  
  // Start periodic thread cleanup (runs every hour)
  setInterval(cleanupOldThreads, 60 * 60 * 1000);
  
  // Auto-save threads every 5 minutes
  setInterval(saveThreads, 5 * 60 * 1000);
  
  log('✅', 'Server initialization complete');
});
