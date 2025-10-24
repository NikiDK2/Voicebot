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
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, {
  origin: true,
});

// Root route
fastify.get("/", async (_, reply) => {
  reply.send({
    message: "RIZIV Outbound Calling Server (WebSocket Only)",
    status: "running",
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

// WebSocket route for campaign media stream
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/campaign-media-stream",
    { websocket: true },
    (connection, req) => {
      console.log("[Server] Twilio connected to campaign media stream");

      const ws = connection.socket; // Fastify wraps the socket

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;

      ws.on("error", (error) => {
        console.error("[Twilio WebSocket] Error:", error);
      });

      const setupElevenLabs = async () => {
        try {
          const agentId = customParameters?.agent_id;
          if (!agentId) {
            console.error("[ElevenLabs] No agent ID provided in parameters");
            console.log(
              "[ElevenLabs] Custom parameters received:",
              customParameters
            );
            return;
          }

          console.log(
            `[ElevenLabs] Setting up connection for agent: ${agentId}`
          );
          const signedUrl = await getSignedUrl(agentId);
          console.log("[ElevenLabs] Connecting to WebSocket...");
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt:
                      customParameters?.prompt ||
                      "You are a helpful assistant speaking Dutch",
                  },
                  first_message: customParameters?.first_message || "",
                },
              },
            };

            console.log(
              "[ElevenLabs] Sending initial config:",
              JSON.stringify(initialConfig, null, 2)
            );
            elevenLabsWs.send(JSON.stringify(initialConfig));
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
                  break;

                case "user_transcript":
                  console.log(
                    `[User]: ${message.user_transcription_event?.user_transcript}`
                  );
                  break;

                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Conversation initiated");
                  break;

                default:
                  console.log(
                    `[ElevenLabs] Received message type: ${message.type}`
                  );
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
        }
      };

      ws.on("message", (message) => {
        try {
          console.log(
            "[Twilio] Raw message received:",
            message.toString().substring(0, 200)
          );
          const msg = JSON.parse(message);
          console.log("[Twilio] Parsed event:", msg.event);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(`[Twilio] Stream started: ${streamSid}`);
              console.log(`[Twilio] Call SID: ${callSid}`);
              console.log(
                `[Twilio] Custom parameters:`,
                JSON.stringify(customParameters)
              );
              setupElevenLabs();
              break;

            case "media":
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

            default:
              console.log(`[Twilio] Received event: ${msg.event}`);
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
  console.log(`[Server] WebSocket Server running on port ${PORT}`);
  console.log(
    `[Server] Ready to handle ElevenLabs calls (no database required)`
  );
});
