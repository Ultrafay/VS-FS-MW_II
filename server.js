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

// Try multiple possible API URL formats
const POSSIBLE_API_URLS = [
  process.env.FRESHCHAT_API_URL,
  'https://empirica-906850564203647665.myfreshworks.com/v2',
  'https://empirica-906850564203647665.freshchat.com/v2',
  'https://api.freshchat.com/v2',
  'https://empirica-906850564203647665-c95c7c8abb1a17c17625165.freshchat.com/v2',
  'https://empirica-906850564203647665-c95c7c8abb1a17c17625165.myfreshworks.com/v2'
].filter(url => url); // Remove null/undefined

console.log('\n' + '='.repeat(70));
console.log('🔍 FRESHCHAT API DIAGNOSTIC');
console.log('='.repeat(70));
console.log('Will test these API URLs:');
POSSIBLE_API_URLS.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
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
let WORKING_API_URL = null; // Store the working URL once found

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Test which API URL works
async function findWorkingApiUrl() {
  if (WORKING_API_URL) return WORKING_API_URL;

  console.log('\n🔍 Testing API URLs to find the working one...\n');

  for (const apiUrl of POSSIBLE_API_URLS) {
    try {
      console.log(`Testing: ${apiUrl}`);
      const response = await axios.get(
        `${apiUrl}/accounts/configuration`,
        {
          headers: {
            'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );
      
      console.log(`✅ SUCCESS! Found working API URL: ${apiUrl}\n`);
      WORKING_API_URL = apiUrl;
      return apiUrl;
      
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
      if (error.response?.data) {
        console.log(`   Error: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  throw new Error('Could not find working API URL. Please check your credentials.');
}

// Send message to Freshchat
async function sendFreshchatMessage(conversationId, message, channelId = null) {
  const apiUrl = await findWorkingApiUrl();
  
  const attempts = [
    {
      name: 'With actor_id',
      payload: BOT_AGENT_ID ? {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'agent',
        actor_id: BOT_AGENT_ID
      } : null
    },
    {
      name: 'Without actor_id',
      payload: {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'agent'
      }
    },
    {
      name: 'With channel_id',
      payload: channelId ? {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'agent',
        channel_id: channelId
      } : null
    },
    {
      name: 'System actor',
      payload: {
        message_parts: [{ text: { content: message } }],
        message_type: 'normal',
        actor_type: 'system'
      }
    },
    {
      name: 'Minimal',
      payload: {
        message_parts: [{ text: { content: message } }]
      }
    }
  ].filter(a => a.payload !== null);

  log('📤', `Sending to conversation: ${conversationId}`);
  log('📝', `Message: ${message.substring(0, 100)}...`);

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    
    try {
      log('🔄', `Attempt ${i + 1}/${attempts.length}: ${attempt.name}`);
      
      const response = await axios.post(
        `${apiUrl}/conversations/${conversationId}/messages`,
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
      return response.data;
      
    } catch (error) {
      log('❌', `Failed: ${error.response?.status} - ${error.message}`);
      
      if (i === attempts.length - 1) {
        log('💥', 'All attempts failed:', error.response?.data || error.message);
        throw error;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

async function assignToHumanAgent(conversationId) {
  const apiUrl = await findWorkingApiUrl();
  
  try {
    await axios.put(
      `${apiUrl}/conversations/${conversationId}`,
      { status: 'assigned' },
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    log('✅', `Conversation ${conversationId} escalated`);
    return true;
  } catch (error) {
    log('❌', 'Error escalating:', error.response?.data || error.message);
    throw error;
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
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;

      if (runStatus.status === 'failed' || runStatus.status === 'expired') {
        throw new Error(`Assistant run ${runStatus.status}`);
      }
    }

    if (attempts >= maxAttempts) {
      throw new Error('Assistant timeout');
    }

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data[0].content[0].text.value;
    log('🤖', `Response: ${assistantMessage.substring(0, 200)}...`);

    const needsEscalation = assistantMessage.includes('ESCALATE_TO_HUMAN');
    let cleanMessage = assistantMessage;
    let escalationReason = '';
    
    if (needsEscalation) {
      const match = assistantMessage.match(/ESCALATE_TO_HUMAN:\s*(.+)/);
      escalationReason = match ? match[1].trim() : 'User request';
      cleanMessage = assistantMessage.replace(/ESCALATE_TO_HUMAN:.+/g, '').trim();
      
      if (!cleanMessage) {
        cleanMessage = "Let me connect you with one of our team members.";
      }
    }

    return {
      response: cleanMessage,
      threadId: thread.id,
      needsEscalation,
      escalationReason
    };

  } catch (error) {
    log('❌', 'OpenAI error:', error.message);
    throw error;
  }
}

async function processMessageAsync(conversationId, messageContent, channelId = null) {
  try {
    log('🔄', '═'.repeat(70));
    log('🔄', `Processing: ${conversationId}`);
    log('💬', `Message: "${messageContent}"`);
    log('🔄', '═'.repeat(70));

    let threadId = conversationThreads.get(conversationId);

    const { response, threadId: newThreadId, needsEscalation, escalationReason } = 
      await getAssistantResponse(messageContent, threadId);

    conversationThreads.set(conversationId, newThreadId);

    log('📤', 'Sending to Freshchat...');
    await sendFreshchatMessage(conversationId, response, channelId);

    if (needsEscalation) {
      log('🚨', `Escalating: ${escalationReason}`);
      await assignToHumanAgent(conversationId);
      await sendFreshchatMessage(
        conversationId, 
        'A team member will be with you shortly!',
        channelId
      );
    }

    log('✅', '═'.repeat(70));
    log('✅', `Completed: ${conversationId}`);
    log('✅', '═'.repeat(70));

  } catch (error) {
    log('❌', '═'.repeat(70));
    log('❌', `Error: ${conversationId}`);
    log('❌', error.message);
    log('❌', '═'.repeat(70));
    
    try {
      await sendFreshchatMessage(
        conversationId,
        "I'm having trouble. Let me connect you with a human agent.",
        channelId
      );
      await assignToHumanAgent(conversationId);
    } catch (fallbackError) {
      log('❌', 'Fallback failed:', fallbackError.message);
    }
  }
}

// Webhook endpoint
app.post('/freshchat-webhook', async (req, res) => {
  try {
    res.status(200).json({ success: true, message: 'Webhook received' });
    
    log('📥', '═'.repeat(70));
    log('📥', 'WEBHOOK RECEIVED');
    log('📥', '═'.repeat(70));
    
    const { actor, action, data } = req.body;
    
    log('📋', 'Data:', {
      actor_type: actor?.actor_type,
      action: action,
      conversation_id: data?.message?.conversation_id
    });
    
    if (action === 'message_create' && actor?.actor_type === 'user') {
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      const channelId = data?.message?.channel_id;
      
      if (!conversationId || !messageContent) {
        log('⚠️', 'Missing required data');
        return;
      }

      log('💬', `User message: "${messageContent}"`);
      
      processMessageAsync(conversationId, messageContent, channelId)
        .catch(err => log('❌', 'Async error:', err.message));
      
    } else {
      log('ℹ️', `Ignoring: ${action} from ${actor?.actor_type}`);
    }
    
  } catch (error) {
    log('❌', 'Webhook error:', error.message);
  }
});

// COMPREHENSIVE DIAGNOSTIC ENDPOINT
app.get('/diagnose', async (req, res) => {
  const results = {
    timestamp: new Date().toISOString(),
    environment: {},
    apiUrls: {},
    openai: {},
    freshchat: {},
    recommendations: []
  };

  // Check environment variables
  results.environment = {
    FRESHCHAT_API_KEY: !!FRESHCHAT_API_KEY ? '✅ Set' : '❌ Missing',
    FRESHCHAT_API_URL: process.env.FRESHCHAT_API_URL || '❌ Not set',
    OPENAI_API_KEY: !!OPENAI_API_KEY ? '✅ Set' : '❌ Missing',
    ASSISTANT_ID: ASSISTANT_ID || '❌ Missing',
    BOT_AGENT_ID: BOT_AGENT_ID || '⚠️ Optional but recommended'
  };

  // Test all possible API URLs
  for (const url of POSSIBLE_API_URLS) {
    try {
      const response = await axios.get(
        `${url}/accounts/configuration`,
        {
          headers: {
            'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );
      
      results.apiUrls[url] = {
        status: '✅ WORKING',
        statusCode: response.status,
        accountInfo: response.data
      };
      
      if (!WORKING_API_URL) {
        WORKING_API_URL = url;
        results.recommendations.push(`Use this API URL: ${url}`);
      }
      
    } catch (error) {
      results.apiUrls[url] = {
        status: '❌ FAILED',
        error: error.message,
        statusCode: error.response?.status,
        details: error.response?.data
      };
    }
  }

  // Test OpenAI
  try {
    await openai.models.list();
    results.openai.status = '✅ Connected';
  } catch (error) {
    results.openai.status = '❌ Failed';
    results.openai.error = error.message;
    results.recommendations.push('Check your OpenAI API key');
  }

  // Summary
  const workingUrls = Object.entries(results.apiUrls)
    .filter(([_, v]) => v.status === '✅ WORKING')
    .map(([k, _]) => k);

  if (workingUrls.length === 0) {
    results.recommendations.push('❌ No working Freshchat API URLs found');
    results.recommendations.push('Check your FRESHCHAT_API_KEY');
    results.recommendations.push('Verify your Freshchat account domain');
  } else {
    results.workingApiUrl = workingUrls[0];
    results.recommendations.push(`Set FRESHCHAT_API_URL=${workingUrls[0]}`);
  }

  res.json(results);
});

// Test message sending
app.get('/debug-send', async (req, res) => {
  const conversationId = req.query.cid;
  
  if (!conversationId) {
    return res.json({ 
      error: 'Missing conversation_id', 
      usage: '/debug-send?cid=YOUR_CONVERSATION_ID' 
    });
  }

  try {
    const apiUrl = await findWorkingApiUrl();
    const results = [];
    
    const formats = [
      {
        name: 'With actor_id',
        payload: BOT_AGENT_ID ? {
          message_parts: [{ text: { content: `Test ${Date.now()}` } }],
          message_type: 'normal',
          actor_type: 'agent',
          actor_id: BOT_AGENT_ID
        } : null
      },
      {
        name: 'Without actor_id',
        payload: {
          message_parts: [{ text: { content: `Test ${Date.now()}` } }],
          message_type: 'normal',
          actor_type: 'agent'
        }
      },
      {
        name: 'System actor',
        payload: {
          message_parts: [{ text: { content: `Test ${Date.now()}` } }],
          message_type: 'normal',
          actor_type: 'system'
        }
      }
    ].filter(f => f.payload);
    
    for (const format of formats) {
      try {
        const response = await axios.post(
          `${apiUrl}/conversations/${conversationId}/messages`,
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
          statusCode: response.status
        });
        
        // Stop after first success
        break;
        
      } catch (error) {
        results.push({
          format: format.name,
          status: '❌ FAILED',
          error: error.response?.data || error.message
        });
      }
    }
    
    res.json({
      conversationId,
      apiUrl,
      timestamp: new Date().toISOString(),
      results
    });
    
  } catch (error) {
    res.json({
      error: error.message,
      conversationId
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    workingApiUrl: WORKING_API_URL,
    activeThreads: conversationThreads.size
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Freshchat-OpenAI Integration (Diagnostic)',
    version: '4.0.0',
    endpoints: {
      diagnose: 'GET /diagnose - Full diagnostic',
      webhook: 'POST /freshchat-webhook',
      debug: 'GET /debug-send?cid=CONVERSATION_ID',
      health: 'GET /health'
    }
  });
});

const PORT = process.env.PORT || 3000;

// Find working API URL on startup
findWorkingApiUrl()
  .then(url => {
    console.log(`\n✅ Found working API URL: ${url}\n`);
    
    app.listen(PORT, () => {
      console.log('='.repeat(70));
      console.log('🚀 Freshchat-OpenAI Integration Started');
      console.log('='.repeat(70));
      console.log(`📍 Port: ${PORT}`);
      console.log(`🔗 Webhook: POST /freshchat-webhook`);
      console.log(`🔍 Diagnose: GET /diagnose`);
      console.log(`🐛 Debug: GET /debug-send?cid=CONVERSATION_ID`);
      console.log('='.repeat(70) + '\n');
    });
  })
  .catch(error => {
    console.error('\n❌ STARTUP FAILED');
    console.error(`Could not find working Freshchat API URL`);
    console.error(`Error: ${error.message}`);
    console.error('\nPlease check:');
    console.error('1. Your FRESHCHAT_API_KEY is correct');
    console.error('2. Your Freshchat account domain');
    console.error('3. API access is enabled in Freshchat settings\n');
    process.exit(1);
  });
