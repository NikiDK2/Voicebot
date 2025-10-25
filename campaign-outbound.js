import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import Twilio from "twilio";
import mysql from "mysql2/promise";

// Load environment variables
dotenv.config();

const {
  ELEVENLABS_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  DB_HOST,
  DB_NAME,
  DB_USER,
  DB_PASS,
} = process.env;

// Validate required environment variables
if (
  !ELEVENLABS_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, {
  origin: true,
});

const PORT = process.env.PORT || 8000;

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Database connection pool
const dbPool = mysql.createPool({
  host: DB_HOST || "ID313555_Xentrographics2.db.webhosting.be",
  database: DB_NAME || "ID313555_Xentrographics2",
  user: DB_USER || "ID313555_Xentrographics2",
  password: DB_PASS || "Dekimpen2025",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000, // 30 seconden timeout
});

// Root route
fastify.get("/", async (_, reply) => {
  reply.send({ message: "RIZIV Outbound Calling Server", status: "running" });
});

// Helper: Get signed URL
async function getSignedUrl(agentId) {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      {
        method: "GET",
        headers: { "xi-api-key": ELEVENLABS_API_KEY },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Helper: Get Belgian greeting
function getBelgianGreeting() {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return "goedemorgen";
  else if (hour >= 12 && hour < 18) return "goede middag";
  else return "goede avond";
}

// Helper: Build prompt and first message
function buildPromptAndMessage(contact, customPrompt, customFirstMessage) {
  const greeting = getBelgianGreeting();
  const doctorName = contact.doctor_name || "Doctor";
  const nameParts = doctorName.split(" ");
  const lastName = nameParts[nameParts.length - 1];
  const firstName = nameParts.slice(0, -1).join(" ") || lastName;

  let prompt =
    customPrompt ||
    `Je bent Sophie, een professionele assistente die belt namens een medische organisatie. ` +
      `Je spreekt Nederlands op een professionele maar vriendelijke manier. ` +
      `Je belt met Dr. ${lastName}, een medisch professional. ` +
      `Wees beleefd, professioneel en respectvol van hun tijd.`;

  let firstMessage = customFirstMessage || "";

  // Replace placeholders
  if (customFirstMessage) {
    firstMessage = firstMessage
      .replace(/\{\{achternaam\}\}/g, lastName)
      .replace(/\{\{voornaam\}\}/g, firstName)
      .replace(/\{\{naam\}\}/g, doctorName)
      .replace(/\{\{greeting\}\}/g, greeting)
      .replace(/\{\{begroeting\}\}/g, greeting);
  }

  return { prompt, firstMessage };
}

// Route: Start campaign
fastify.post("/start-campaign", async (request, reply) => {
  const { campaign_id, agent_id, custom_prompt, first_message } = request.body;

  if (!campaign_id || !agent_id) {
    return reply.code(400).send({
      success: false,
      error: "Campaign ID and Agent ID are required",
    });
  }

  console.log(`Starting campaign ${campaign_id} with agent ${agent_id}`);

  try {
    // Get pending contacts from database
    const [contacts] = await dbPool.execute(
      `SELECT id, riziv_nummer, doctor_name, phone_number 
       FROM campaign_contacts 
       WHERE campaign_id = ? AND call_status = 'pending'
       ORDER BY id ASC`,
      [campaign_id]
    );

    if (contacts.length === 0) {
      return reply.send({
        success: true,
        message: "No pending contacts to call",
      });
    }

    console.log(`Found ${contacts.length} contacts to call`);

    // Start calling process (async - don't wait)
    processCallQueue(
      campaign_id,
      agent_id,
      custom_prompt,
      first_message,
      contacts
    );

    reply.send({
      success: true,
      campaign_id,
      contacts_to_call: contacts.length,
      message: "Campaign started",
    });
  } catch (error) {
    console.error("Error starting campaign:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to start campaign",
      details: error.message,
    });
  }
});

// Process call queue
async function processCallQueue(
  campaignId,
  agentId,
  customPrompt,
  customFirstMessage,
  contacts
) {
  console.log(`Processing ${contacts.length} calls for campaign ${campaignId}`);

  for (const contact of contacts) {
    try {
      // Update status to calling
      await dbPool.execute(
        `UPDATE campaign_contacts 
         SET call_status = 'calling', called_at = NOW() 
         WHERE id = ?`,
        [contact.id]
      );

      // Build prompt and message
      const { prompt, firstMessage } = buildPromptAndMessage(
        contact,
        customPrompt,
        customFirstMessage
      );

      // Initiate call
      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: contact.phone_number,
        url:
          `http://${
            process.env.SERVER_HOST || "localhost"
          }:${PORT}/campaign-call-twiml?` +
          `contact_id=${contact.id}&campaign_id=${campaignId}&agent_id=${agentId}&` +
          `prompt=${encodeURIComponent(prompt)}&` +
          `first_message=${encodeURIComponent(firstMessage)}`,
        statusCallback: `http://${
          process.env.SERVER_HOST || "localhost"
        }:${PORT}/call-status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });

      console.log(`Call initiated: ${call.sid} to ${contact.phone_number}`);

      // Update with call SID
      await dbPool.execute(
        `UPDATE campaign_contacts 
         SET call_sid = ? 
         WHERE id = ?`,
        [call.sid, contact.id]
      );

      // Insert call log
      await dbPool.execute(
        `INSERT INTO outbound_call_logs 
         (campaign_id, contact_id, call_sid, from_number, to_number, agent_id, call_status)
         VALUES (?, ?, ?, ?, ?, ?, 'initiated')`,
        [
          campaignId,
          contact.id,
          call.sid,
          TWILIO_PHONE_NUMBER,
          contact.phone_number,
          agentId,
        ]
      );

      // Wait between calls to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 seconds between calls
    } catch (error) {
      console.error(`Error calling ${contact.phone_number}:`, error);

      // Update status to failed
      await dbPool.execute(
        `UPDATE campaign_contacts 
         SET call_status = 'failed', error_message = ?, completed_at = NOW() 
         WHERE id = ?`,
        [error.message, contact.id]
      );
    }
  }

  console.log(`Finished processing campaign ${campaignId}`);

  // Update campaign status
  await dbPool.execute(
    `UPDATE calling_campaigns 
     SET status = 'completed', completed_at = NOW() 
     WHERE id = ?`,
    [campaignId]
  );
}

// TwiML route for campaign calls
fastify.all("/campaign-call-twiml", async (request, reply) => {
  const { prompt, first_message, contact_id, campaign_id, agent_id } =
    request.query;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/campaign-media-stream">
          <Parameter name="prompt" value="${prompt || ""}" />
          <Parameter name="first_message" value="${first_message || ""}" />
          <Parameter name="contact_id" value="${contact_id || ""}" />
          <Parameter name="campaign_id" value="${campaign_id || ""}" />
          <Parameter name="agent_id" value="${agent_id || ""}" />
        </Stream>
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Call status callback
fastify.post("/call-status", async (request, reply) => {
  const { CallSid, CallStatus, CallDuration } = request.body;

  console.log(
    `Call ${CallSid} status: ${CallStatus}, duration: ${CallDuration}`
  );

  try {
    // Update call log
    await dbPool.execute(
      `UPDATE outbound_call_logs 
       SET call_status = ?, call_duration = ? 
       WHERE call_sid = ?`,
      [CallStatus, CallDuration || 0, CallSid]
    );

    // Update campaign contact
    if (CallStatus === "completed") {
      await dbPool.execute(
        `UPDATE campaign_contacts 
         SET call_status = 'completed', call_duration = ?, completed_at = NOW() 
         WHERE call_sid = ?`,
        [CallDuration || 0, CallSid]
      );

      // Update campaign stats
      await dbPool.execute(
        `UPDATE calling_campaigns c
         SET completed_calls = (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND call_status = 'completed'),
             successful_calls = (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND call_status = 'completed' AND call_duration > 10),
             failed_calls = (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND call_status = 'failed')
         WHERE id = (SELECT campaign_id FROM campaign_contacts WHERE call_sid = ? LIMIT 1)`,
        [CallSid]
      );
    }
  } catch (error) {
    console.error("Error updating call status:", error);
  }

  reply.send({ received: true });
});

// WebSocket route for campaign media stream
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/campaign-media-stream",
    { websocket: true },
    (connection, req) => {
      console.log("[Server] Twilio connected to campaign media stream");
      console.log(
        "[Server] Request headers:",
        JSON.stringify(req.headers, null, 2)
      );
      console.log("[Server] Request URL:", req.url);

      const ws = connection.socket; // Fastify wraps the socket

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;

      ws.on("error", console.error);

      const setupElevenLabs = async () => {
        try {
          console.log("[ElevenLabs] setupElevenLabs called");
          const agentId = customParameters?.agent_id;
          const campaignId = customParameters?.campaign_id;

          console.log(
            `[ElevenLabs] Agent ID: ${agentId}, Campaign ID: ${campaignId}`
          );

          if (!agentId) {
            console.error("[ElevenLabs] No agent ID provided");
            return;
          }

          // Fetch prompt from database if campaign_id is provided
          let prompt =
            customParameters?.prompt || "You are a helpful assistant";
          let firstMessage = customParameters?.first_message || "";

          if (campaignId) {
            console.log(
              `[Database] Fetching prompt for campaign ${campaignId} via PHP proxy`
            );
            try {
              // Fetch via PHP proxy instead of direct MySQL (avoids whitelist issues)
              const phpProxyUrl =
                "https://www.innovationstudio.be/get-campaign-prompt.php";
              const response = await fetch(
                `${phpProxyUrl}?campaign_id=${campaignId}`
              );

              if (!response.ok) {
                throw new Error(`PHP proxy returned status ${response.status}`);
              }

              const data = await response.json();
              console.log(
                `[Database] PHP proxy response:`,
                JSON.stringify(data).substring(0, 200)
              );

              if (data.success && data.temp_prompt) {
                prompt = data.temp_prompt;
                console.log(
                  `[Database] Retrieved prompt via PHP proxy (${prompt.length} chars)`
                );
              }
              if (data.success && data.temp_first_message) {
                firstMessage = data.temp_first_message;
                console.log(
                  `[Database] Retrieved first message via PHP proxy (${firstMessage.length} chars)`
                );
              }
            } catch (fetchError) {
              console.error(
                "[Database] Error fetching via PHP proxy:",
                fetchError
              );
              console.log(
                "[ElevenLabs] Using fallback prompt from customParameters"
              );
            }
          }

          console.log("[ElevenLabs] Getting signed URL...");
          const signedUrl = await getSignedUrl(agentId);
          console.log("[ElevenLabs] Got signed URL, connecting...");
          elevenLabsWs = new WebSocket(signedUrl);
          console.log("[ElevenLabs] WebSocket created");

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Log the prompt we're sending
            console.log(
              "[ElevenLabs] Prompt being sent:",
              prompt.substring(0, 100) + "..."
            );
            console.log(
              "[ElevenLabs] First message being sent:",
              firstMessage || "(empty)"
            );

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt: prompt,
                  },
                  first_message: firstMessage,
                },
              },
            };

            console.log("[ElevenLabs] Sending initial config to ElevenLabs");
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "audio":
                  // Audio streaming - no logging to reduce spam
                  if (streamSid) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload:
                          message.audio?.chunk ||
                          message.audio_event?.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({ event: "clear", streamSid }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(
                      JSON.stringify({
                        type: "pong",
                        event_id: message.ping_event.event_id,
                      })
                    );
                  }
                  break;

                case "agent_response":
                  console.log(
                    `[Agent]: ${message.agent_response_event?.agent_response}`
                  );
                  // Store in database
                  if (customParameters?.contact_id) {
                    dbPool
                      .execute(
                        `UPDATE outbound_call_logs 
                       SET conversation_data = JSON_ARRAY_APPEND(
                         COALESCE(conversation_data, '[]'), 
                         '$', 
                         JSON_OBJECT('type', 'agent', 'text', ?, 'timestamp', NOW())
                       )
                       WHERE call_sid = ?`,
                        [message.agent_response_event?.agent_response, callSid]
                      )
                      .catch(console.error);
                  }
                  break;

                case "user_transcript":
                  console.log(
                    `[User]: ${message.user_transcription_event?.user_transcript}`
                  );
                  // Store in database
                  if (customParameters?.contact_id) {
                    dbPool
                      .execute(
                        `UPDATE outbound_call_logs 
                       SET transcript = CONCAT(COALESCE(transcript, ''), ?, '\n'),
                           conversation_data = JSON_ARRAY_APPEND(
                             COALESCE(conversation_data, '[]'), 
                             '$', 
                             JSON_OBJECT('type', 'user', 'text', ?, 'timestamp', NOW())
                           )
                       WHERE call_sid = ?`,
                        [
                          message.user_transcription_event?.user_transcript,
                          message.user_transcription_event?.user_transcript,
                          callSid,
                        ]
                      )
                      .catch(console.error);
                  }
                  break;
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
          console.error("[ElevenLabs] Error stack:", error.stack);
        }
      };

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);

          // Only log non-media events to reduce log spam
          if (msg.event !== "media") {
            console.log("[Twilio] Received message event:", msg.event);
          }

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(`[Twilio] Stream started: ${streamSid}`);
              console.log(
                "[Twilio] Custom parameters received:",
                JSON.stringify(customParameters, null, 2)
              );
              setupElevenLabs();
              break;

            case "media":
              // Audio streaming - no logging to reduce spam
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    msg.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

// Start server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] RIZIV Outbound Calling Server running on port ${PORT}`);
  console.log(`[Server] Ready to process campaigns`);
});
