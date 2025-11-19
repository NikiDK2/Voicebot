import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyCors from "@fastify/cors";

dotenv.config();

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, { origin: true });

const PORT = process.env.PORT || 8000;

// Helper: Get signed URL
async function getSignedUrl(agentId) {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      {
        method: "GET",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
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

fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/campaign-media-stream", { websocket: true }, (connection, req) => {
    console.log("[Server] Twilio connected to campaign media stream");
    const ws = connection.socket;

    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null;
    let silenceTimer = null;
    let lastActivity = Date.now();

    ws.on("error", console.error);

    // Function to reset silence timer
    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        console.log("[Twilio] No activity for 5 seconds, hanging up call");
        if (streamSid) {
          ws.send(JSON.stringify({ event: "stop", streamSid }));
        }
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
        ws.close();
      }, 5000); // 5 seconds
    };

    // Function to check for closing phrases
    const checkForClosingPhrase = (text) => {
      const lowerText = text.toLowerCase();
      const closingPhrases = [
        'bedankt voor uw tijd en succes met uw accreditatie',
        'bedankt voor uw tijd en nog een fijne dag',
        'bedankt voor de tijd en nog een fijne dag',
        'bedankt en nog een fijne dag'
      ];
      for (const phrase of closingPhrases) {
        if (lowerText.includes(phrase)) {
          console.log(`[ElevenLabs] Closing phrase detected: "${phrase}", hanging up immediately`);
          if (streamSid) {
            ws.send(JSON.stringify({ event: "stop", streamSid }));
          }
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
          }
          return true;
        }
      }
      return false;
    };

    ws.on("message", async (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== "media") {
          console.log("[Twilio] Received message event:", msg.event);
        }

        switch (msg.event) {
            case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            customParameters = msg.start.customParameters;
            lastActivity = Date.now();
            console.log(`[Twilio] Stream started: ${streamSid}`);
            console.log(`[Twilio] Call SID: ${callSid}`);
            console.log(`[Twilio] Custom Parameters:`, JSON.stringify(customParameters, null, 2));

            const agentId = customParameters?.agent_id;
            if (!agentId) {
              console.error("[ElevenLabs] No agent ID provided");
              return;
            }

            try {
              const signedUrl = await getSignedUrl(agentId);
              elevenLabsWs = new WebSocket(signedUrl);

              elevenLabsWs.on("open", () => {
                console.log("[ElevenLabs] Connected to Conversational AI");
                const prompt = customParameters?.prompt || "You are a helpful assistant";
                const firstMessage = customParameters?.first_message || "";
                
                // Add contact_id and campaign_id to metadata so they're available in webhook
                const initialConfig = {
                  type: "conversation_initiation_client_data",
                  conversation_config_override: {
                    agent: { prompt: { prompt }, first_message: firstMessage },
                  },
                  // Add metadata with contact_id and campaign_id for webhook matching
                  metadata: {
                    contact_id: customParameters?.contact_id || null,
                    campaign_id: customParameters?.campaign_id || null,
                    call_sid: callSid || null,
                  },
                };
                
                console.log(`[ElevenLabs] Sending metadata:`, JSON.stringify(initialConfig.metadata, null, 2));
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
                    lastActivity = Date.now();
                    resetSilenceTimer();
                  }
                  if (message.type === "agent_response") {
                    const text = message.agent_response_event?.agent_response || "";
                    console.log(`[Agent]: ${text}`);
                    if (checkForClosingPhrase(text)) return;
                    lastActivity = Date.now();
                    resetSilenceTimer();
                  }
                  if (message.type === "user_transcript") {
                    console.log(`[User]: ${message.user_transcription_event?.user_transcript}`);
                    lastActivity = Date.now();
                    resetSilenceTimer();
                  }
                } catch (error) {
                  console.error("[ElevenLabs] Error:", error);
                }
              });
            } catch (error) {
              console.error("[ElevenLabs] Setup error:", error);
            }
            resetSilenceTimer();
            break;

          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.send(JSON.stringify({
                user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
              }));
              lastActivity = Date.now();
              resetSilenceTimer();
            }
            break;

          case "stop":
            console.log(`[Twilio] Stream ${streamSid} ended`);
            if (silenceTimer) clearTimeout(silenceTimer);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;
        }
      } catch (error) {
        console.error("[Twilio] Error:", error);
      }
    });

    ws.on("close", () => {
      console.log("[Twilio] Client disconnected");
      if (silenceTimer) clearTimeout(silenceTimer);
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] RIZIV Outbound Calling Server running on port ${PORT}`);
});
