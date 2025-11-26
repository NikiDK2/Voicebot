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

// Helper to get signed URL from ElevenLabs
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

// Helper to fetch full call configuration (prompt) from PHP API
async function getCallConfig(campaignId, contactId, callSid, agentId) {
  try {
    const apiUrl = `https://innovationstudio.be/Scraper/get-call-config.php?campaign_id=${campaignId}&contact_id=${contactId}&call_sid=${callSid}&agent_id=${agentId}`;
    console.log(`[Server] Fetching config from: ${apiUrl}`);
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (error) {
    console.error("[Server] Error fetching call config:", error);
    return null;
  }
}

fastify.register(async (fastifyInstance) => {
  const websocketHandler = (connection, req) => {
    console.log(`[Server] ✅ Twilio connected to ${req.url}`);
    
    const ws = connection.socket;
    let streamSid = null;
    let elevenLabsWs = null;

    console.log(`[Twilio] Initial Socket State: ${ws.readyState} (OPEN=${WebSocket.OPEN})`);

    ws.on("error", (err) => console.error("[Twilio] Socket Error:", err));

    ws.on("message", async (message) => {
      try {
        const msgStr = message.toString();
        const msg = JSON.parse(msgStr);
        
        if (msg.event !== "media") {
           console.log(`[Twilio] Received event: ${msg.event}`);
        }

        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          const callSid = msg.start.callSid;
          const params = msg.start.customParameters;
          console.log(`[Twilio] Stream started: ${streamSid}`);
          
          // Default values from Twilio params (which might be truncated)
          let prompt = params?.prompt || "You are a helpful assistant";
          let firstMessage = params?.first_message || "";
          const agentId = params?.agent_id;

          // FETCH FULL PROMPT FROM API if IDs are present
          if (params?.campaign_id && params?.contact_id) {
             const config = await getCallConfig(params.campaign_id, params.contact_id, callSid, agentId);
             if (config) {
               console.log(`[Server] ✅ Loaded full prompt (${config.prompt.length} chars) from API`);
               prompt = config.prompt;
               firstMessage = config.first_message;
             } else {
               console.log(`[Server] ⚠️ Failed to load config from API, using provided params`);
             }
          }

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
                      prompt: { prompt: prompt }, 
                      first_message: firstMessage 
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
