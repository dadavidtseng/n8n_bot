require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');

const token = process.env.DISCORD_BOT_TOKEN;
const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
const targetChannelId = process.env.TARGET_CHANNEL_ID;

// Create client with required intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent // IMPORTANT: Must be enabled in Developer Portal!
    ]
});

// When bot is ready
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    if (targetChannelId) {
      console.log(`Listening for mentions in specific channel: ${targetChannelId}`);
    } else {
      console.log(`Listening for mentions in any channel.`);
    }
});

// When a message is created
client.on('messageCreate', async message => {
    // 1. Ignore messages from self OR when bot is NOT mentioned
    if (message.author.bot || !message.mentions.has(client.user)) {
       return;
    }

    // 2. Optional: Only respond in target channel
    if (targetChannelId && message.channel.id !== targetChannelId) {
        console.log(`Ignoring mention in wrong channel: ${message.channel.id}`);
        return;
    }

    // 3. Extract the question (remove the mention)
    const question = message.content.replace(`<@${client.user.id}>`, '').trim();
    const channelId = message.channel.id;

    // 3.5 Check if a question was actually asked
    if (!question) {
        console.log(`Bot mentioned without a question by ${message.author.tag}. Ignoring.`);
        // Optional: Send a help message
        // message.reply("Mention me and ask a question, e.g. `@MyBot How are you?`");
        return;
    }

    console.log(`Received question from channel ${channelId} by ${message.author.tag}: "${question}"`);

    // Show "typing..." continuously while waiting for response
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(err => {
            console.error('Error sending typing indicator:', err);
            clearInterval(typingInterval);
        });
    }, 5000); // Send typing indicator every 5 seconds

    // For very long processes, send a status update
    let statusMessageSent = false;
    const statusTimeout = setTimeout(() => {
        message.reply("I'm still working on your request. This might take a bit longer than usual.");
        statusMessageSent = true;
    }, 20000); // Send status message after 20 seconds

    try {
        // 4. Send the question and channel ID to n8n with increased timeout
        const responseFromN8n = await axios.post(n8nWebhookUrl, {
            question: question,
            channelId: channelId,
            userId: message.author.id,
            userName: message.author.username
        }, {
            timeout: 300000 // Increase timeout to 5 minutes (300 seconds)
        });

        // Clear the intervals
        clearInterval(typingInterval);
        clearTimeout(statusTimeout);

        // Debug logging of complete response
        console.log('Complete response from n8n:', JSON.stringify(responseFromN8n.data));

        // 5. Enhanced response processing with multiple format handling
        let answer;
        
        // Try different response structures
        if (responseFromN8n.data && responseFromN8n.data.answer) {
            // Standard format: { "answer": "..." }
            answer = responseFromN8n.data.answer;
        } else if (Array.isArray(responseFromN8n.data) && responseFromN8n.data[0]?.answer) {
            // Array format: [{ "answer": "..." }]
            answer = responseFromN8n.data[0].answer;
        } else if (typeof responseFromN8n.data === 'string') {
            // Direct string format
            answer = responseFromN8n.data;
        } else {
            // Fallback: Try to find any structure
            console.log('No known response structure found, trying fallback parsing...');
            const jsonStr = JSON.stringify(responseFromN8n.data);
            console.log('Raw data:', jsonStr);
            
            if (jsonStr.includes('"answer"')) {
                try {
                    // Manual extraction of answer field
                    const match = jsonStr.match(/"answer"\s*:\s*"([^"]+)"/);
                    if (match && match[1]) {
                        answer = match[1];
                    }
                } catch (parseError) {
                    console.error('Error with manual parsing:', parseError);
                }
            }
        }

        // 6. Send the answer to the Discord channel
        if (answer) {
            // Check if the answer exceeds Discord's character limit (2000)
            if (answer.length <= 2000) {
                // Standard reply if message is short enough
                message.reply(answer);
                console.log(`Sent answer from n8n: "${answer.substring(0, 100)}..."`);
            } else {
                // Split long messages into chunks of 1900 characters (leaving room for formatting)
                const chunks = [];
                let temp = answer;
                
                while (temp.length > 0) {
                    // Find a good breaking point (preferably at a paragraph or sentence)
                    let breakPoint = 1900;
                    if (temp.length > breakPoint) {
                        // Try to find paragraph break
                        const paragraphBreak = temp.lastIndexOf('\n\n', breakPoint);
                        if (paragraphBreak > breakPoint / 2) {
                            breakPoint = paragraphBreak;
                        } else {
                            // Try to find sentence break
                            const sentenceBreak = temp.lastIndexOf('. ', breakPoint);
                            if (sentenceBreak > breakPoint / 2) {
                                breakPoint = sentenceBreak + 1; // Include the period
                            }
                        }
                    } else {
                        breakPoint = temp.length;
                    }
                    
                    chunks.push(temp.substring(0, breakPoint));
                    temp = temp.substring(breakPoint);
                }
                
                // Send first chunk as a reply to the original message
                await message.reply(chunks[0]);
                console.log(`Sent first chunk of answer (${chunks[0].length} chars)`);
                
                // Send remaining chunks as follow-up messages
                for (let i = 1; i < chunks.length; i++) {
                    await message.channel.send(chunks[i]);
                    console.log(`Sent chunk ${i+1} of ${chunks.length} (${chunks[i].length} chars)`);
                    
                    // Small delay between messages to avoid rate limiting
                    if (i < chunks.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
        } else {
            message.reply("I did not receive a valid answer from my n8n workflow.");
            console.log('Received empty or invalid answer structure from n8n:', responseFromN8n.data);
        }

    } catch (error) {
        // Clear the intervals on error
        clearInterval(typingInterval);
        clearTimeout(statusTimeout);

        console.error('Error interacting with n8n or Discord:', error.message);
        message.reply("Oops, something went wrong when communicating with n8n. Please try again later.");
        // Detailed error handling for n8n response errors
        if (error.response) {
          console.error('n8n responded with status:', error.response.status);
          console.error('n8n response data:', error.response.data);
        } else if (error.request) {
          console.error('No response received from n8n request:', error.request);
        } else {
          console.error('Error setting up request:', error.message);
        }
    }
});

// Log in the bot
client.login(token);