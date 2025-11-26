import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";

dotenv.config();

// Configuration
const PORT = process.env.PORT || 8000;
const { ELEVENLABS_API_KEY } = process.env;

// Validate config
if (!ELEVENLABS_API_KEY) {
  console.error("❌ Missing ELEVENLABS_API_KEY in environment variables");
}

// Initialize Fastify with trustProxy for Render
const fastify = Fastify({ 
  logger: true,
  trustProxy: true 
});

// Plugins
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, { 
  origin: true,
  credentials: true
});

// Logging hook
fastify.addHook('onRequest', async (request, reply) => {
  if (request.headers.upgrade && request.headers.upgrade.toLowerCase() === 'websocket') {
    console.log(`[DEBUG] [Server] 🚀 WebSocket Upgrade Request: ${request.url}`);
  }
});

// Root route
fastify.get("/", async (_, reply) => {
  reply.send({
    message: "RIZIV Outbound Calling Server",
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
    if (!response.ok) throw new Error(`Failed: ${response.statusText}`);
    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// WebSocket route
fastify.register(async (fastifyInstance) => {
  // Handler function to reuse for both routes
  const websocketHandler = (connection, req) => {
    console.log(`[Server] ✅ Twilio connected to ${req.url}`);
    
    const ws = connection.socket;
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null;
    let silenceTimer = null;
    let lastActivity = Date.now();

    ws.on("error", console.error);

    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        // Optional: Close on timeout
      }, 20000);
    };

    ws.on("message", async (message) => {
      try {
        const msg = JSON.parse(message);
        
        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            customParameters = msg.start.customParameters;
            console.log(`[Twilio] Stream started: ${streamSid} (Call: ${callSid})`);

            const agentId = customParameters?.agent_id;
            if (!agentId) return console.error("[ElevenLabs] No agent ID provided");

            try {
              const signedUrl = await getSignedUrl(agentId);
              elevenLabsWs = new WebSocket(signedUrl);

              elevenLabsWs.on("open", () => {
                console.log("[ElevenLabs] Connected to AI");
                const initialConfig = {
                  type: "conversation_initiation_client_data",
                  conversation_config_override: {
                    agent: { 
                      prompt: { prompt: customParameters?.prompt || "You are a helpful assistant" }, 
                      first_message: customParameters?.first_message || "" 
                    },
                  },
                };
                elevenLabsWs.send(JSON.stringify(initialConfig));
              });

              elevenLabsWs.on("message", (data) => {
                try {
                  const message = JSON.parse(data);
                  if (message.type === "audio" && streamSid) {
                    ws.send(JSON.stringify({
                      event: "media",
                      streamSid,
                      media: { payload: message.audio?.chunk || message.audio_event?.audio_base_64 },
                    }));
                    resetSilenceTimer();
                  }
                  if (message.type === "agent_response") {
                    console.log(`[Agent]: ${message.agent_response_event?.agent_response}`);
                  }
                  if (message.type === "user_transcript") {
                    console.log(`[User]: ${message.user_transcription_event?.user_transcript}`);
                  }
                } catch (error) {
                  console.error("[ElevenLabs] Error:", error);
                }
              });

              elevenLabsWs.on("error", (e) => console.error("[ElevenLabs] WS Error:", e));
              elevenLabsWs.on("close", () => console.log("[ElevenLabs] Disconnected"));

            } catch (error) {
              console.error("[ElevenLabs] Setup error:", error);
            }
            break;

          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.send(JSON.stringify({
                user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
              }));
              resetSilenceTimer();
            }
            break;

          case "stop":
            console.log(`[Twilio] Stream ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
            break;
        }
      } catch (error) {
        console.error("[Twilio] Error:", error);
      }
    });

    ws.on("close", () => {
      console.log("[Twilio] Client disconnected");
      if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
  };

  // Register primary route
  fastifyInstance.get("/campaign-media-stream", { websocket: true }, websocketHandler);
  
  // Register V2 route (fallback/fix)
  fastifyInstance.get("/campaign-media-stream-v2", { websocket: true }, websocketHandler);
});

// Start server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] RIZIV Outbound Calling Server running on ${address}`);
});
