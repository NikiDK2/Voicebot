import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";

dotenv.config();

const PORT = process.env.PORT || 8000;
const { ELEVENLABS_API_KEY } = process.env;

const fastify = Fastify({ 
  logger: true,
  trustProxy: true 
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, { origin: true, credentials: true });

fastify.addHook('onRequest', async (request, reply) => {
  if (request.headers.upgrade && request.headers.upgrade.toLowerCase() === 'websocket') {
    console.log(`[DEBUG] [Server] 🚀 WebSocket Upgrade Request: ${request.url}`);
  }
});

fastify.get("/", async (_, reply) => {
  reply.send({ status: "running", timestamp: new Date().toISOString() });
});

async function getSignedUrl(agentId) {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      { method: "GET", headers: { "xi-api-key": ELEVENLABS_API_KEY } }
    );
    if (!response.ok) throw new Error(`Failed: ${response.statusText}`);
    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

fastify.register(async (fastifyInstance) => {
  const websocketHandler = (connection, req) => {
    console.log(`[Server] ✅ Twilio connected to ${req.url}`);
    
    const ws = connection.socket;
    let streamSid = null;
    let elevenLabsWs = null;

    console.log(`[Twilio] Initial Socket State: ${ws.readyState} (OPEN=${WebSocket.OPEN})`);

    // Register error handler immediately
    ws.on("error", (err) => console.error("[Twilio] Socket Error:", err));

    // Handle incoming messages from Twilio
    ws.on("message", async (message) => {
      try {
        const msgStr = message.toString();
        const msg = JSON.parse(msgStr);
        
        if (msg.event !== "media") {
           console.log(`[Twilio] Received event: ${msg.event}`);
        }

        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          console.log(`[Twilio] Stream started: ${streamSid}`);
          
          // ElevenLabs Setup
          const agentId = msg.start.customParameters?.agent_id;
          if (agentId) {
            console.log(`[ElevenLabs] Initializing for agent: ${agentId}`);
            try {
              const signedUrl = await getSignedUrl(agentId);
              elevenLabsWs = new WebSocket(signedUrl);
              
              elevenLabsWs.on("open", () => {
                console.log("[ElevenLabs] Connected to WebSocket API");
                const initialConfig = {
                  type: "conversation_initiation_client_data",
                  conversation_config_override: {
                    agent: { 
                      prompt: { prompt: msg.start.customParameters?.prompt || "You are a helpful assistant" }, 
                      first_message: msg.start.customParameters?.first_message || "" 
                    },
                  },
                };
                elevenLabsWs.send(JSON.stringify(initialConfig));
              });

              elevenLabsWs.on("message", (data) => {
                try {
                  const message = JSON.parse(data);
                  
                  if (message.type === "audio" && streamSid && ws.readyState === WebSocket.OPEN) {
                    const audioPayload = {
                      event: "media",
                      streamSid,
                      media: { payload: message.audio?.chunk || message.audio_event?.audio_base_64 },
                    };
                    ws.send(JSON.stringify(audioPayload));
                  }
                  
                  // Log agent responses for debugging
                  if (message.type === "agent_response") {
                    console.log(`[Agent]: ${message.agent_response_event?.agent_response}`);
                  }

                } catch (parseErr) {
                  console.error("[ElevenLabs] Parse Error:", parseErr);
                }
              });
              
              elevenLabsWs.on("error", (e) => console.error("[ElevenLabs] Error:", e));
              elevenLabsWs.on("close", () => console.log("[ElevenLabs] Disconnected"));
              
            } catch (e) {
              console.error("[ElevenLabs] Setup failed:", e);
            }
          } else {
            console.error("[Twilio] No agent_id in start parameters");
          }
        } else if (msg.event === "media") {
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
              user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
            }));
          }
        } else if (msg.event === "stop") {
          console.log(`[Twilio] Stream stopped by Twilio`);
          if (elevenLabsWs) elevenLabsWs.close();
        }
      } catch (error) {
        console.error("[Twilio] Message Processing Error:", error);
      }
    });

    ws.on("close", () => {
      console.log("[Twilio] Client disconnected");
      if (elevenLabsWs) elevenLabsWs.close();
    });
  };

  fastifyInstance.get("/campaign-media-stream", { websocket: true }, websocketHandler);
  fastifyInstance.get("/campaign-media-stream-v2", { websocket: true }, websocketHandler);
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error("Error:", err);
    process.exit(1);
  }
  console.log(`[Server] Running on ${address}`);
});
