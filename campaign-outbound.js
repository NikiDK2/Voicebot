import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";

// Load environment variables
dotenv.config();

const { ELEVENLABS_API_KEY, PORT = 8000 } = process.env;

// Validate required environment variables
if (!ELEVENLABS_API_KEY) {
  console.error("Missing ELEVENLABS_API_KEY environment variable");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify({ 
  logger: true,
  trustProxy: true // Belangrijk voor Render.com
});

// Register plugins
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, {
  origin: true,
  credentials: true
});

// Root route - Health Check
fastify.get("/", async (_, reply) => {
  reply.send({
    message: "RIZIV Outbound Calling Server (WebSocket Only)",
    status: "running",
    timestamp: new Date().toISOString()
  });
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
      const errorText = await response.text();
      throw new Error(
        `Failed to get signed URL (${response.status}): ${errorText}`
      );
    }

    const data = await response.json();
    console.log(`[ElevenLabs] Got signed URL for agent ${agentId}`);
    return data.signed_url;
  } catch (error) {
    console.error("[ElevenLabs] Error getting signed URL:", error);
    throw error;
  }
}

// WebSocket route registration - Directe registratie na plugin
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/campaign-media-stream",
    { websocket: true },
    (connection, req) => {
      console.log("[Server] Twilio connected to campaign media stream");
      
      // Access request details safely
      const requestDetails = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        ip: req.socket?.remoteAddress
      };
      
      console.log("[DEBUG] Connection details:", JSON.stringify(requestDetails));

      const ws = connection.socket; // Fastify wraps the socket

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;
      let audioBuffer = [];
      let isElevenLabsReady = false;

      // Handle Twilio WebSocket errors
      ws.on("error", (error) => {
        console.error("[Twilio WebSocket] Error:", error);
      });

      // Handle Twilio WebSocket close
      ws.on("close", () => {
        console.log("[Twilio WebSocket] Closed");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });

      // Handle incoming messages from Twilio
      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(`[Twilio] Stream started: ${streamSid}`);
              console.log(`[Twilio] Call SID: ${callSid}`);
              
              // Setup ElevenLabs connection
              setupElevenLabs(customParameters);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN && isElevenLabsReady) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    msg.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              } else {
                // Buffer audio if ElevenLabs is not ready
                audioBuffer.push(msg.media.payload);
                if (audioBuffer.length > 50) audioBuffer.shift(); // Keep buffer small
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;
              
            case "connected":
                console.log("[Twilio] Connected event received");
                break;

            default:
              console.log(`[Twilio] Received event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Function to setup ElevenLabs connection
      const setupElevenLabs = async (params) => {
        try {
          const agentId = params?.agent_id;
          if (!agentId) {
            console.error("[ElevenLabs] No agent ID provided in parameters");
            return;
          }

          console.log(`[ElevenLabs] Setting up connection for agent: ${agentId}`);
          const signedUrl = await getSignedUrl(agentId);
          
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt: params?.prompt || "You are a helpful assistant",
                  },
                  first_message: params?.first_message || "",
                },
              },
            };
            
            // Add metadata if available
            if (params?.contact_id || params?.campaign_id) {
                initialConfig.conversation_config_override.metadata = {
                    contact_id: params.contact_id,
                    campaign_id: params.campaign_id,
                    call_sid: callSid
                };
            }

            console.log("[ElevenLabs] Sending initial config");
            elevenLabsWs.send(JSON.stringify(initialConfig));
            
            isElevenLabsReady = true;
            
            // Send buffered audio
            while (audioBuffer.length > 0) {
                const chunk = audioBuffer.shift();
                const audioMessage = {
                  user_audio_chunk: Buffer.from(chunk, "base64").toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
            }
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "audio":
                  if (streamSid) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio?.chunk || message.audio_event?.audio_base_64,
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
                    console.log(`[Agent]: ${message.agent_response_event?.agent_response}`);
                    break;
                    
                case "user_transcript":
                    console.log(`[User]: ${message.user_transcription_event?.user_transcript}`);
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
            isElevenLabsReady = false;
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };
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
  console.log(`[Server] Ready to handle ElevenLabs calls`);
});
