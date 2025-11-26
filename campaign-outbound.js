import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";

// Ultra-minimal debug server
const fastify = Fastify({ 
  logger: true,
  trustProxy: true 
});

fastify.register(fastifyWs);
fastify.register(fastifyCors, { origin: true });

const PORT = process.env.PORT || 8000;

// Log every single request at the TCP/HTTP level
fastify.addHook('onRequest', async (request, reply) => {
  console.log(`[DEBUG] 📨 ${request.method} ${request.url}`);
  console.log(`[DEBUG] Headers: ${JSON.stringify(request.headers)}`);
});

fastify.get('/', async () => {
  return { status: 'debug-mode-active' };
});

// The critical route
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get('/campaign-media-stream', { websocket: true }, (connection, req) => {
    console.log('!!! WEBSOCKET CONNECTION ESTABLISHED !!!');
    
    connection.socket.on('message', (msg) => {
      console.log(`[WS] Message received: ${msg.toString().substring(0, 50)}...`);
    });
    
    connection.socket.on('close', () => {
      console.log('[WS] Closed');
    });
    
    connection.socket.on('error', (err) => {
      console.error('[WS] Error:', err);
    });
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`DEBUG SERVER LISTENING ON ${address}`);
});
