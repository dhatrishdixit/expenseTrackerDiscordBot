require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const path = require('path');

const http = require('http');
http.createServer((req, res) => {
    if(req.url== '/health-check'){
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('bot is alive\n');
    }
}).listen(8080);

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

// Parse expense message with improved validation
function parseExpense(message) {
  // Support formats:
  // !expense 12.50 food "lunch with team"
  // !expense 5.99 coffee 2023-05-20
  const match = message.match(/!expense\s+(\d+\.?\d*)\s+(\S+)\s+(?:["']([^"']+)["']|(\S[^-0-9]+?))(?:\s+(\d{4}-\d{2}-\d{2}))?$/);
  
  if (!match) return null;

  const amount = parseFloat(match[1]);
  const category = match[2];
  const description = match[3] || match[4] || 'No description';
  const date = match[5] || new Date().toISOString().split('T')[0];
  const user = message.author.username;

  return [date, amount, category, description, user];
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
      console.log('Raw input:', message.content);
  
      const expenseData = parseExpense(message.content);
      console.log('Parsed data:', expenseData);
  
      if (!expenseData) {
        console.log('Format validation failed');
        return message.reply('Invalid format. Try: `!expense 5.99 coffee "latte"`');
      }
  
      try {
        console.log('Attempting Google Auth...');
        const authClient = await authorize();
        console.log('Auth successful, client email:', authClient._client.email);
  
        console.log('Attempting sheet append...');
        const success = await appendToSheet(authClient, expenseData);
        console.log('Append result:', success);
  
        if (success) {
          console.log('Success - sending confirmation');
          return message.reply(`✅ Logged $${expenseData[1]} for ${expenseData[2]}`);
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