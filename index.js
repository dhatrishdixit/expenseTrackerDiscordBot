require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const path = require('path');

const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health-check') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Bot is alive\n');
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Use Render's provided port
server.listen(process.env.PORT || 3000, () => {
  console.log(`Health check server running on port ${process.env.PORT || 3000}`);
});

// Initialize Discord client
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Google Sheets setup
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const SPREADSHEET_ID = process.env.SHEET_ID;
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

// Sheet configuration
const SHEET_NAME = 'Expenses';
const COLUMNS = ['Date', 'Amount', 'Category', 'Description', 'User'];

// Authorize Google Sheets
async function authorize() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: SCOPES,
  });
  return auth;
}

// Initialize or verify the sheet structure
async function initializeSheet(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  
  try {
    // Check if sheet exists, create if not
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });

    const sheetExists = spreadsheet.data.sheets.some(
      sheet => sheet.properties.title === SHEET_NAME
    );

    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{
            addSheet: {
              properties: {
                title: SHEET_NAME,
                gridProperties: {
                  rowCount: 1000,
                  columnCount: COLUMNS.length,
                }
              }
            }
          }]
        }
      });
      console.log(`Created new sheet: ${SHEET_NAME}`);
    }

    // Set headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:${String.fromCharCode(65 + COLUMNS.length - 1)}1`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [COLUMNS],
      },
    });

    // Format header row
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: sheetExists ? 
                spreadsheet.data.sheets.find(s => s.properties.title === SHEET_NAME).properties.sheetId : 0,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: COLUMNS.length
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.8, green: 0.9, blue: 1.0 }
              }
            },
            fields: 'userEnteredFormat(textFormat,backgroundColor)'
          }
        }]
      }
    });

    console.log('Sheet initialized with headers');
    return true;
  } catch (err) {
    console.error('Error initializing sheet:', err);
    return false;
  }
}

// Append expense data to sheet
async function appendToSheet(auth, data) {
  const sheets = google.sheets({ version: 'v4', auth });
  const range = `${SHEET_NAME}!A2:${String.fromCharCode(65 + COLUMNS.length - 1)}`;
  
  try {
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [data],
      },
    });
    
    console.log('Data appended:', response.data.updates.updatedRange);
    return true;
  } catch (err) {
    console.error('Error appending to sheet:', err);
    return false;
  }
}

function parseExpense(input) {
    // Determine if input is a Message object or raw string
    const content = typeof input === 'string' ? input : input.content;
    const author = typeof input === 'string' ? 'System' : input.author?.username || 'Unknown';
  
    // Remove command prefix and trim
    const commandContent = content.replace(/^!expense\s+/i, '').trim();
    
    // Split into parts (supporting quoted descriptions)
    const parts = commandContent.match(/(?:[^\s"']+|["'][^"']*["'])+/g) || [];
    
    // Minimum: amount and category
    if (parts.length < 2) {
      console.log('Parse failed - insufficient parts');
      return null;
    }
  
    // Parse amount (remove $ if present)
    const amount = parseFloat(parts[0].replace('$', ''));
    if (isNaN(amount)) {
      console.log('Parse failed - invalid amount');
      return null;
    }
  
    // Get category (remove quotes if present)
    const category = parts[1].replace(/["']/g, '');
  
    // Handle description and date
    let description = 'No description';
    let date = new Date().toISOString().split('T')[0]; // Default today
  
    if (parts.length > 2) {
      // Check if last part is a date (YYYY-MM-DD)
      if (parts[parts.length-1].match(/^\d{4}-\d{2}-\d{2}$/)) {
        date = parts.pop(); // Remove date from parts
      }
      description = parts.slice(2).join(' ').replace(/["']/g, '');
    }
  
    return [date, amount, category, description, author];
  }

// Discord bot events
discordClient.on('ready', async () => {
  console.log(`Logged in as ${discordClient.user.tag}`);
  try {
    const authClient = await authorize();
    await initializeSheet(authClient);
  } catch (error) {
    console.error('Failed to initialize sheet:', error);
    process.exit(1);
  }
});

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('!expense')) {
    console.log('\n--- NEW MESSAGE ---');
    console.log('Full message object:', {
      content: message.content,
      author: message.author?.username,
      channel: message.channel?.name
    });

    const expenseData = parseExpense(message); // Pass the full message object
    console.log('Parsed data:', expenseData);

    if (!expenseData) {
      console.log('Format validation failed');
      return message.reply('Invalid format. Try: `!expense 5.99 coffee "latte"`');
    }
  
      try {
        console.log('Attempting Google Auth...');
        const authClient = await authorize();
        console.log('Auth successful, client email:', process.env.EMAIL);
  
        console.log('Attempting sheet append...');
        const success = await appendToSheet(authClient, expenseData);
        console.log('Append result:', success);
  
        if (success) {
          console.log('Success - sending confirmation');
          return message.reply(`✅ Logged $${expenseData[1]} for ${expenseData[2]}
               open your sheet: https://docs.google.com/spreadsheets/d/1ZuyFF3tKiS8FUZyoZo4_E_TXBz7emC5aR5UPgUSKaqM/edit?usp=sharing
            `);
        } else {
          console.log('Append failed silently');
          return message.reply('❌ Failed silently - check bot logs');
        }
      } catch (error) {
        console.error('FULL ERROR:', error);
        return message.reply('🔥 CRASHED: ' + error.message);
      }
    }
  });
// Start the bot
discordClient.login(process.env.DISCORD_TOKEN);
