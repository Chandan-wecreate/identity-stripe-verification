const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const stripe = require('stripe')('sk_test_51IgZ1HAy6mgpkkqAlsASKtiU0l36fMJsDktMByiuJg6DYzo9GNHi9ArHeZkcAr9v11rSH3d6T1tqpDGWk3DeKalz00Xtd7jXBM');
const WebSocket = require('ws');

const app = express();
const port = 4000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Create the HTTP server and WebSocket server
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = new Set();

wss.on('connection', (ws) => {
    console.log('Client connected');
    clients.add(ws);

    ws.on('close', () => {
        console.log('Client disconnected');
        clients.delete(ws);
    });
});

// Handle Stripe webhooks
app.post('/webhook', async (req, res) => {
    const event = req.body;

    // Handle the event
    switch (event.type) {
        case 'identity.verification_session.verified':
            const session = event.data.object;

            // Notify all connected clients
            for (const client of clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'verification_completed',
                        data: session,
                    }));
                }
            }
            break;
        // ... handle other event types
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    // Return a response to acknowledge receipt of the event
    res.json({ received: true });
});

// Endpoint to create a verification session
app.post('/create-verification-session', async (req, res) => {
    try {
        const verificationSession = await stripe.identity.verificationSessions.create({
            type: 'document',
            options: {
                document: {
                    require_matching_selfie: true
                }
            }
        });

        const url = verificationSession.client_secret;
        res.json({ url });
    } catch (error) {
        console.error('Error creating verification session:', error);
        res.status(500).send('Internal Server Error');
    }
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

module.exports = app;