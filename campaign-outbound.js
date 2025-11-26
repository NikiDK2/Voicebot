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

    // RAW LOGGING
    // Delay listener attachment slightly to ensure socket is ready
    setImmediate(() => {
      ws.on("open", () => console.log("[Twilio] Socket OPEN"));
      ws.on("ping", () => console.log("[Twilio] Ping received"));
      ws.on("pong", () => console.log("[Twilio] Pong received"));
      
      // Log current state
      console.log(`[Twilio] Socket State: ${ws.readyState} (OPEN=${WebSocket.OPEN})`);

      ws.on("message", async (message) => {
        // ... existing message logic ...
        const msgStr = message.toString();
        // console.log(`[Twilio] Msg received: ${msgStr.substring(0, 100)}`); // Uncomment for deep debug
        
        try {
          const msg = JSON.parse(msgStr);
          // ... rest of logic


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
