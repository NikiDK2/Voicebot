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

// Root route for health check (required for Render.com)
fastify.get("/", async (request, reply) => {
  console.log("[DEBUG] [Server] Health check endpoint called");
  return reply.send({ 
    message: "RIZIV Outbound Calling Server running",
    status: "ok",
    websocket_endpoint: "/campaign-media-stream",
    timestamp: new Date().toISOString()
  });
});

// Test endpoint om te controleren of WebSocket route bestaat
fastify.get("/test-websocket-route", async (request, reply) => {
  return reply.send({ 
    message: "WebSocket route test endpoint",
    websocket_route: "/campaign-media-stream",
    status: "Route should be available at wss://voicebot-w8gx.onrender.com/campaign-media-stream",
    note: "This is an HTTP endpoint. The WebSocket route is at /campaign-media-stream"
  });
});

// Helper: Get signed URL
async function getSignedUrl(agentId) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      const error = new Error("ELEVENLABS_API_KEY is not set in environment variables");
      console.error("[DEBUG] [ElevenLabs] ❌ CRITICAL ERROR:", error.message);
      throw error;
    }
    
    console.log(
      "[DEBUG] [ElevenLabs] 🔄 Requesting signed URL from ElevenLabs API",
      "Agent ID:", agentId,
      "API Key present:", !!process.env.ELEVENLABS_API_KEY,
      "API Key length:", process.env.ELEVENLABS_API_KEY?.length || 0
    );
    
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      {
        method: "GET",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[DEBUG] [ElevenLabs] ❌ ElevenLabs API error:",
        "Status:", response.status,
        "StatusText:", response.statusText,
        "Response:", errorText
      );
      throw new Error(`ElevenLabs API failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const data = await response.json();
    if (!data.signed_url) {
      console.error("[DEBUG] [ElevenLabs] ❌ No signed_url in response:", JSON.stringify(data));
      throw new Error("No signed_url in ElevenLabs API response");
    }
    
    console.log(
      "[DEBUG] [ElevenLabs] ✅ Successfully got signed URL",
      "URL length:", data.signed_url?.length || 0
    );
    
    return data.signed_url;
  } catch (error) {
    console.error(
      "[DEBUG] [ElevenLabs] ❌ Error getting signed URL:",
      error.message,
      "Stack:", error.stack
    );
    throw error;
  }
}

// Register WebSocket route directly on fastify (not nested in register)
fastify.get(
  "/campaign-media-stream",
  { websocket: true },
  (connection, req) => {
    console.log(
      "[DEBUG] [Server] ✅ Twilio connected to campaign media stream",
      "Timestamp:",
      new Date().toISOString(),
        "Request URL:",
        req.url,
        "Method:",
        req.method,
        "Headers:",
        JSON.stringify(req.headers)
      );
      const ws = connection.socket;
      
      // Log immediately when WebSocket connection is established
      console.log(
        "[DEBUG] [Server] 🔌 WebSocket connection established",
        "ReadyState:", ws.readyState,
        "Protocol:", ws.protocol || "none",
        "URL:", req.url
      );

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;
      let silenceTimer = null;
      let closingPhraseTimer = null;
      let lastActivity = Date.now();
      let lastAudioTime = Date.now();
      let callStartTime = Date.now(); // Track wanneer de call is gestart
      let closingPhraseDetected = false;
      let lastAgentResponse = ""; // Track laatste agent response om premature end_call te detecteren
      let audioBuffer = []; // Buffer audio chunks tot ElevenLabs WebSocket is open
      let elevenLabsReady = false; // Track of ElevenLabs WebSocket is ready
      let elevenLabsSetupAttempted = false; // Track of we al geprobeerd hebben om ElevenLabs op te zetten (voor fallback)
      let silenceTimerResetCount = 0; // Tel hoeveel keer de silence timer is gereset zonder closing phrase
      let callEnding = false; // Flag om te tracken of de call wordt beëindigd

      ws.on("error", console.error);

      // Function to reset silence timer (verhoogd naar 25 seconden voor meer geduld)
      // KRITIEK: Silence timer mag ALLEEN het gesprek beëindigen als één van de 4 closing phrases is gezegd
      // MAAR: Er zijn maximum timeouts om oneindige loops te voorkomen
      const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          const timeSinceLastActivity = Date.now() - lastActivity;
          const totalCallDuration = Date.now() - callStartTime;
          
          // MAXIMUM TIMEOUTS om oneindige loops te voorkomen:
          // 1. Als er meer dan 5 minuten geen activiteit is geweest, forceer einde
          const MAX_INACTIVITY_TIME = 5 * 60 * 1000; // 5 minuten
          // 2. Als de call langer dan 10 minuten duurt, forceer einde
          const MAX_CALL_DURATION = 10 * 60 * 1000; // 10 minuten
          // 3. Als de silence timer meer dan 20 keer is gereset zonder closing phrase, forceer einde
          const MAX_SILENCE_RESETS = 20;
          
          // Check of er een closing phrase is gedetecteerd
          if (!closingPhraseDetected) {
            silenceTimerResetCount++;
            
            // Check maximum timeouts
            if (timeSinceLastActivity > MAX_INACTIVITY_TIME) {
              console.log(
                "[DEBUG] [Twilio] ⚠️ FORCED CALL END - Maximum inactivity time exceeded",
                "TimeSinceLastActivity:", Math.round(timeSinceLastActivity / 1000), "seconds",
                "Max allowed:", MAX_INACTIVITY_TIME / 1000, "seconds (5 minutes)",
                "CallSid:", callSid
              );
              // Forceer einde na te lange inactiviteit
              forceEndCall("Maximum inactivity time exceeded (5 minutes)", {
                timeSinceLastActivity,
                silenceTimerResetCount
              });
              return;
            }
            
            if (totalCallDuration > MAX_CALL_DURATION) {
              console.log(
                "[DEBUG] [Twilio] ⚠️ FORCED CALL END - Maximum call duration exceeded",
                "TotalCallDuration:", Math.round(totalCallDuration / 1000), "seconds",
                "Max allowed:", MAX_CALL_DURATION / 1000, "seconds (10 minutes)",
                "CallSid:", callSid
              );
              // Forceer einde na te lange call duur
              forceEndCall("Maximum call duration exceeded (30 minutes)", {
                totalCallDuration,
                silenceTimerResetCount
              });
              return;
            }
            
            if (silenceTimerResetCount > MAX_SILENCE_RESETS) {
              console.log(
                "[DEBUG] [Twilio] ⚠️ FORCED CALL END - Maximum silence timer resets exceeded",
                "ResetCount:", silenceTimerResetCount,
                "Max allowed:", MAX_SILENCE_RESETS,
                "CallSid:", callSid
              );
              // Forceer einde na te veel resets
              forceEndCall("Maximum silence timer resets exceeded", {
                silenceTimerResetCount,
                timeSinceLastActivity
              });
              return;
            }
            
            console.log(
              "[DEBUG] [Twilio] Silence timer triggered but NO closing phrase detected - NOT hanging up!",
              "Het gesprek mag ALLEEN eindigen na: 'Nog een fijne dag', 'Prettige dag', 'Fijne dag', of 'succes met uw accreditatie'",
              "ClosingPhraseDetected:", closingPhraseDetected,
              "LastActivity:", new Date(lastActivity).toISOString(),
              "TimeSinceLastActivity:", Math.round(timeSinceLastActivity / 1000), "seconds",
              "TotalCallDuration:", Math.round(totalCallDuration / 1000), "seconds",
              "SilenceTimerResetCount:", silenceTimerResetCount,
              "MaxResets:", MAX_SILENCE_RESETS
            );
            // Reset de timer opnieuw - geef meer tijd
            resetSilenceTimer();
            return;
          }
          
          // Reset counter als closing phrase is gedetecteerd
          silenceTimerResetCount = 0;
          
          // Gebruik safeEndCall om te garanderen dat het gesprek alleen eindigt met closing phrase
          safeEndCall("Silence timer - closing phrase was detected", {
            closingPhraseDetected,
            timeSinceLastActivity: Date.now() - lastActivity
          });
        }, 25000); // 25 seconden - geeft veel meer tijd voor vragen/luisteren
      };
      
      // Forceer call einde (voor maximum timeouts)
      const forceEndCall = (reason, details = {}) => {
        console.log(
          "[DEBUG] 🚨 FORCED CALL END 🚨",
          "Reason:", reason,
          "CallSid:", callSid,
          "Details:", JSON.stringify(details)
        );
        
        // Stop Twilio stream
        if (streamSid) {
          ws.send(JSON.stringify({ event: "stop", streamSid }));
        }
        
        // Close ElevenLabs WebSocket
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
        
        // Close Twilio WebSocket
        ws.close();
      };
      
      // Helper functie om activiteit bij te werken en reset counter te resetten
      const updateActivity = () => {
        lastActivity = Date.now();
        // Reset de silence timer reset counter bij nieuwe activiteit
        if (silenceTimerResetCount > 0) {
          console.log(
            "[DEBUG] [Twilio] Activity detected - resetting silence timer reset counter",
            "Previous reset count:", silenceTimerResetCount
          );
          silenceTimerResetCount = 0;
        }
      };
      
      // Helper function om te loggen wanneer het gesprek wordt beëindigd
      const logCallEnd = (reason, details = {}) => {
        console.log(
          "[DEBUG] 🚨 CALL ENDING 🚨",
          "Reason:", reason,
          "ClosingPhraseDetected:", closingPhraseDetected,
          "LastAgentResponse:", lastAgentResponse.substring(0, 100),
          "StreamSid:", streamSid,
          "CallSid:", callSid,
          "Details:", JSON.stringify(details)
        );
      };
      
      // KRITIEKE VEILIGHEIDSFUNCTIE: Blokkeer ALLE call endings tenzij closingPhraseDetected = true
      const safeEndCall = (reason, details = {}) => {
        // KRITIEKE CHECK: Het gesprek mag ALLEEN eindigen als closingPhraseDetected = true
        if (!closingPhraseDetected) {
          console.log(
            "[DEBUG] 🚫 BLOCKED CALL END - NO CLOSING PHRASE! 🚫",
            "Reason:", reason,
            "ClosingPhraseDetected:", closingPhraseDetected,
            "LastAgentResponse:", lastAgentResponse.substring(0, 200),
            "Het gesprek mag ALLEEN eindigen na: 'Nog een fijne dag', 'Prettige dag', 'Fijne dag', of 'succes met uw accreditatie'",
            "Details:", JSON.stringify(details)
          );
          return false; // Blokkeer het einde van het gesprek
        }
        
        // Zet flag dat call wordt beëindigd - stop met audio verwerken
        callEnding = true;
        
        // Leeg audio buffer - we gaan de call beëindigen
        audioBuffer = [];
        
        // Alleen als closingPhraseDetected = true, log en eindig het gesprek
        logCallEnd(reason, details);
        
        // Stop Twilio stream eerst - dit stopt nieuwe audio
        if (streamSid) {
          ws.send(JSON.stringify({ event: "stop", streamSid }));
        }
        
        // Wacht kort om laatste audio te verwerken voordat we sluiten
        setTimeout(() => {
        // Close ElevenLabs WebSocket
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
        
        // Close Twilio WebSocket
          if (ws.readyState === WebSocket.OPEN) {
        ws.close();
          }
        }, 500); // Wacht 500ms om laatste audio te verwerken
        
        return true; // Gesprek succesvol beëindigd
      };

      // Function to check for closing phrases (met delay zodat bot kan afronden)
      // BELANGRIJK: Alleen de ECHTE afsluitingszinnen triggeren een call end
      // "Ik activeer uw account" is NIET een afsluiting!
      const checkForClosingPhrase = (text) => {
        const lowerText = text.toLowerCase();
        // ALLEEN deze 4 zinnen mogen het gesprek beëindigen - NIETS anders!
        const closingPhrases = [
          "nog een fijne dag",
          "prettige dag",
          "fijne dag",
          "succes met uw accreditatie",
        ];

        for (const phrase of closingPhrases) {
          // KRITIEK: Check of de closing phrase aan het EINDE van de tekst staat
          // Dit voorkomt false positives als de phrase ergens in het midden voorkomt
          const phraseIndex = lowerText.indexOf(phrase);
          
          if (phraseIndex !== -1) {
            // Check of de phrase aan het einde staat (laatste 100 karakters)
            // Dit geeft wat ruimte voor eventuele leestekens na de closing phrase
            const textEnd = lowerText.substring(Math.max(0, lowerText.length - 150));
            const phraseAtEnd = textEnd.includes(phrase);
            
            console.log(
              `[DEBUG] Closing phrase check: "${phrase}"`,
              "Found at index:",
              phraseIndex,
              "Text length:",
              lowerText.length,
              "Phrase at end (last 150 chars):",
              phraseAtEnd,
              "Text end:",
              textEnd.substring(Math.max(0, textEnd.length - 100))
            );
            
            // Alleen detecteren als de phrase aan het einde van de tekst staat
            if (phraseAtEnd) {
              // Als we nog geen closing phrase hebben gedetecteerd, start timer
              if (!closingPhraseDetected) {
                closingPhraseDetected = true;
                console.log(
                  `[DEBUG] ✅ Closing phrase detected at END of text: "${phrase}"`,
                  "Setting closingPhraseDetected = true",
                  "Will hang up in 25 seconds to let bot finish",
                  "Full text:", text.substring(0, 300)
                );

              // Clear eventuele bestaande closing timer
              if (closingPhraseTimer) clearTimeout(closingPhraseTimer);

              // Wacht minimaal 25 seconden zodat de bot zijn zin kan afmaken (15 + 10 extra)
              // KRITIEK: We moeten wachten tot de volledige closing phrase is uitgesproken
              closingPhraseTimer = setTimeout(() => {
                // Check of er recent nog audio is geweest (bot spreekt nog)
                const timeSinceLastAudio = Date.now() - lastAudioTime;

                console.log(
                  "[DEBUG] Closing phrase timer triggered",
                  "TimeSinceLastAudio:", timeSinceLastAudio, "ms",
                  "ClosingPhraseDetected:", closingPhraseDetected
                );

                // Als er in de laatste 5 seconden nog audio was, wacht nog langer
                // Dit geeft de bot meer tijd om de volledige closing phrase uit te spreken
                if (timeSinceLastAudio < 5000) {
                  console.log(
                    "[DEBUG] Bot still speaking (audio within last 5 seconds), waiting additional 8 seconds..."
                  );
                  setTimeout(() => {
                    const finalTimeSinceAudio = Date.now() - lastAudioTime;
                    console.log(
                      "[DEBUG] Final check after additional wait",
                      "TimeSinceLastAudio:", finalTimeSinceAudio, "ms"
                    );
                    
                    // Nog steeds recent audio? Wacht nog langer
                    if (finalTimeSinceAudio < 3000) {
                      console.log(
                        "[DEBUG] Bot still speaking, waiting another 5 seconds..."
                      );
                      setTimeout(() => {
                        safeEndCall("Closing phrase timer - bot finished speaking (extended wait)", {
                          closingPhraseDetected,
                          timeSinceLastAudio: Date.now() - lastAudioTime,
                          phrase: "closing phrase"
                        });
                      }, 5000);
                    } else {
                      safeEndCall("Closing phrase timer - bot finished speaking", {
                        closingPhraseDetected,
                        timeSinceLastAudio: Date.now() - lastAudioTime,
                        phrase: "closing phrase"
                      });
                    }
                  }, 8000);
                } else {
                  // Bot is klaar met praten, sluit de call
                  safeEndCall("Closing phrase timer - bot finished (25 seconds waited)", {
                    closingPhraseDetected,
                    timeSinceLastAudio: Date.now() - lastAudioTime,
                    phrase: "closing phrase"
                  });
                }
              }, 25000); // Verhoogd naar 25 seconden (15 + 10 extra) om de bot meer tijd te geven
              }
              return true; // Closing phrase gevonden aan het einde, maar hang up gebeurt pas na delay
            } else {
              console.log(
                `[DEBUG] ⚠️ Closing phrase "${phrase}" found but NOT at end of text - IGNORING`,
                "Phrase index:",
                phraseIndex,
                "Text length:",
                lowerText.length,
                "Text:", text.substring(0, 200)
              );
            }
          }
        }
        return false;
      };

      ws.on("message", async (message) => {
        try {
          // Log ALLE messages voor debugging (ook media)
          const messageStr = message.toString();
          console.log(
            "[DEBUG] [Twilio] 📨 Raw message received:",
            "Length:",
            messageStr.length,
            "First 200 chars:",
            messageStr.substring(0, 200),
            "Timestamp:",
            new Date().toISOString()
          );
          
          const msg = JSON.parse(message);
          
          console.log(
            "[DEBUG] [Twilio] ✅ Parsed message:",
            "Event:",
            msg.event,
            "StreamSid:",
            msg.start?.streamSid || msg.media?.streamSid || streamSid,
            "CallSid:",
            msg.start?.callSid || callSid,
            "ClosingPhraseDetected:",
            closingPhraseDetected,
            "Timestamp:",
            new Date().toISOString()
          );
          
          if (msg.event !== "media") {
            console.log(
              "[DEBUG] [Twilio] 📢 Non-media event received:",
              msg.event,
              "Full message:",
              JSON.stringify(msg).substring(0, 300)
            );
          }

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              callStartTime = Date.now(); // Set call start time when stream starts
              updateActivity();
              console.log(
                "[DEBUG] [Twilio] ✅ Stream started:",
                "StreamSid:", streamSid,
                "CallSid:", callSid,
                "CustomParameters:", JSON.stringify(customParameters, null, 2)
              );
              
              // CRITICAL DEBUG: Log exact customParameters values for batch call troubleshooting
              if (customParameters) {
                console.log(
                  "[DEBUG] [Twilio] 🔍 CRITICAL - CustomParameters breakdown:",
                  "contact_id:", customParameters.contact_id || customParameters.contactId || "MISSING",
                  "campaign_id:", customParameters.campaign_id || customParameters.campaignId || "MISSING",
                  "agent_id:", customParameters.agent_id || customParameters.agentId || "MISSING",
                  "Full customParameters:", JSON.stringify(customParameters)
                );
              } else {
                console.error("[DEBUG] [Twilio] ❌ CRITICAL ERROR - customParameters is NULL or undefined!");
              }

              const agentId = customParameters?.agent_id;
              if (!agentId) {
                console.error("[ElevenLabs] No agent ID provided");
                return;
              }

              try {
                console.log(
                  "[DEBUG] [ElevenLabs] 🔄 Starting ElevenLabs connection setup",
                  "Agent ID:", agentId,
                  "StreamSid:", streamSid,
                  "CallSid:", callSid
                );
                const signedUrl = await getSignedUrl(agentId);
                console.log(
                  "[DEBUG] [ElevenLabs] ✅ Got signed URL from ElevenLabs API",
                  "URL length:", signedUrl?.length || 0,
                  "URL preview:", signedUrl?.substring(0, 80) || "NULL"
                );
                elevenLabsWs = new WebSocket(signedUrl);
                console.log(
                  "[DEBUG] [ElevenLabs] 🔌 WebSocket object created",
                  "Initial readyState:", elevenLabsWs?.readyState,
                  "(0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)"
                );

                elevenLabsWs.on("open", () => {
                  console.log(
                    "[DEBUG] [ElevenLabs] ✅ Connected to Conversational AI WebSocket",
                    "StreamSid:", streamSid,
                    "CallSid:", callSid
                  );
                  let prompt =
                    customParameters?.prompt || "You are a helpful assistant";
                  let firstMessage = customParameters?.first_message || "";
                  
                  // Extract contact_id and campaign_id from customParameters
                  // CRITICAL: These MUST be extracted correctly for batch calls to work
                  const contactId = customParameters?.contact_id || customParameters?.contactId || null;
                  const campaignId = customParameters?.campaign_id || customParameters?.campaignId || null;
                  
                  // Replace template variables in prompt and firstMessage
                  // This allows ElevenLabs to extract these values as metadata
                  const replaceVariables = (text) => {
                    if (!text) return text;
                    return text
                      .replace(/\{\{call_sid\}\}/g, callSid || '')
                      .replace(/\{\{contact_id\}\}/g, contactId || '')
                      .replace(/\{\{campaign_id\}\}/g, campaignId || '');
                  };
                  
                  prompt = replaceVariables(prompt);
                  firstMessage = replaceVariables(firstMessage);
                  
                  console.log(
                    "[DEBUG] [ElevenLabs] Sending initial config:",
                    "Prompt length:", prompt.length,
                    "First message:", firstMessage.substring(0, 100),
                    "Variables replaced: call_sid=" + (callSid || "NULL"),
                    "contact_id=" + (contactId || "NULL"),
                    "campaign_id=" + (campaignId || "NULL")
                  );
                  
                  // CRITICAL DEBUG: Log what we received
                  console.log(
                    "[DEBUG] [ElevenLabs] 🔍 CRITICAL - Extracted values:",
                    "callSid:", callSid,
                    "contactId from customParameters:", contactId,
                    "campaignId from customParameters:", campaignId,
                    "customParameters.contact_id:", customParameters?.contact_id,
                    "customParameters.contactId:", customParameters?.contactId,
                    "customParameters.campaign_id:", customParameters?.campaign_id,
                    "customParameters.campaignId:", customParameters?.campaignId
                  );
                  
                  // Build initial config with metadata for webhook identification
                  const initialConfig = {
                    type: "conversation_initiation_client_data",
                    conversation_config_override: {
                      agent: {
                        prompt: { prompt },
                        first_message: firstMessage,
                      },
                    },
                  };
                  
                  // ALTIJD metadata toevoegen - zelfs als contactId/campaignId null zijn
                  // Dit zorgt ervoor dat ElevenLabs de metadata altijd meeneemt in de webhook
                  // De call_sid is altijd beschikbaar en kan gebruikt worden voor database lookup
                  // BELANGRIJK: Gebruik callSid uit msg.start.callSid (altijd beschikbaar bij stream start)
                  const finalCallSid = callSid || customParameters?.call_sid || null;
                  
                  initialConfig.conversation_config_override.metadata = {
                    call_sid: finalCallSid,
                    contact_id: contactId || null,
                    campaign_id: campaignId || null,
                  };
                  
                  // CRITICAL: Zorg dat metadata ook in conversation_initiation_client_data staat
                  if (!initialConfig.conversation_initiation_client_data) {
                    initialConfig.conversation_initiation_client_data = {};
                  }
                  initialConfig.conversation_initiation_client_data.metadata = {
                    call_sid: finalCallSid,
                    contact_id: contactId || null,
                    campaign_id: campaignId || null,
                  };
                  
                  console.log(
                    "[DEBUG] [ElevenLabs] ✅ Adding metadata to initial config (ALWAYS):",
                    "call_sid:", finalCallSid || "NULL",
                    "contact_id:", contactId || "NULL",
                    "campaign_id:", campaignId || "NULL",
                    "callSid from msg.start:", callSid || "NULL",
                    "call_sid from customParameters:", customParameters?.call_sid || "NULL",
                    "Full metadata object:", JSON.stringify(initialConfig.conversation_config_override.metadata)
                  );
                  
                  // WARNING if critical values are missing
                  if (!contactId || !campaignId) {
                    console.error(
                      "[DEBUG] [ElevenLabs] ⚠️ WARNING - Missing critical metadata:",
                      "contact_id:", contactId || "MISSING",
                      "campaign_id:", campaignId || "MISSING",
                      "call_sid:", callSid || "MISSING",
                      "This may cause incorrect contact identification in batch calls!"
                    );
                  }
                  
                  console.log(
                    "[DEBUG] [ElevenLabs] Initial config structure:",
                    JSON.stringify(initialConfig, null, 2).substring(0, 300)
                  );
                  
                  elevenLabsWs.send(JSON.stringify(initialConfig));
                  console.log("[DEBUG] [ElevenLabs] ✅ Initial config sent to ElevenLabs");
                  
                  // Mark ElevenLabs as ready
                  elevenLabsReady = true;
                  console.log(
                    "[DEBUG] [ElevenLabs] ✅ ElevenLabs WebSocket is now ready - processing buffered audio",
                    "Buffered audio chunks:", audioBuffer.length
                  );
                  
                  // Process any buffered audio chunks (alleen als call niet wordt beëindigd)
                  while (audioBuffer.length > 0 && !callEnding) {
                    const bufferedAudio = audioBuffer.shift();
                    if (elevenLabsWs?.readyState === WebSocket.OPEN && !callEnding) {
                      elevenLabsWs.send(
                        JSON.stringify({
                          user_audio_chunk: Buffer.from(
                            bufferedAudio.payload,
                            "base64"
                          ).toString("base64"),
                        })
                      );
                      console.log(
                        "[DEBUG] [ElevenLabs] ✅ Processed buffered audio chunk"
                      );
                    }
                  }
                  // Leeg buffer als call wordt beëindigd
                  if (callEnding) {
                    audioBuffer = [];
                    console.log(
                      "[DEBUG] [ElevenLabs] ⏸️ Cleared audio buffer - call is ending"
                    );
                  }
                  updateActivity();
                  resetSilenceTimer();
                });
                
                elevenLabsWs.on("error", (error) => {
                  console.error(
                    "[DEBUG] [ElevenLabs] ❌ WebSocket error:",
                    error.message || error,
                    "StreamSid:", streamSid,
                    "CallSid:", callSid,
                    "Error code:", error.code,
                    "Error details:", JSON.stringify(error)
                  );
                });
                
                elevenLabsWs.on("close", (code, reason) => {
                  console.error(
                    "[DEBUG] [ElevenLabs] 🚨 WebSocket CLOSED:",
                    "Code:", code,
                    "Reason:", reason?.toString() || "No reason provided",
                    "StreamSid:", streamSid,
                    "CallSid:", callSid,
                    "ReadyState:", elevenLabsWs?.readyState,
                    "ElevenLabsReady flag:", elevenLabsReady
                  );
                  // Reset ready flag when WebSocket closes
                  elevenLabsReady = false;
                });

                elevenLabsWs.on("message", (data) => {
                  try {
                    const dataStr = data.toString();
                    console.log(
                      "[DEBUG] [ElevenLabs] 📨 Raw message received:",
                      "Length:",
                      dataStr.length,
                      "First 200 chars:",
                      dataStr.substring(0, 200),
                      "Timestamp:",
                      new Date().toISOString()
                    );
                    
                    const message = JSON.parse(data);

                    // Log alle message types voor debugging (behalve audio om spam te voorkomen)
                    if (message.type !== "audio") {
                      console.log(
                        `[DEBUG] [ElevenLabs] ✅ Message received:`,
                        "Type:",
                        message.type,
                        "ClosingPhraseDetected:",
                        closingPhraseDetected,
                        "LastAgentResponse:",
                        lastAgentResponse.substring(0, 100),
                        "Timestamp:",
                        new Date().toISOString(),
                        "Full message (first 500 chars):",
                        JSON.stringify(message).substring(0, 500)
                      );
                      
                      // Log ook of er tool_calls in zitten
                      if (
                        message.tool_calls ||
                        message.transcript?.[0]?.tool_calls ||
                        message.agent_response_event?.tool_calls
                      ) {
                        console.log(
                          `[DEBUG] [ElevenLabs] Message contains tool_calls - logging structure`
                        );
                        console.log(
                          JSON.stringify(message, null, 2).substring(0, 500)
                        );
                      }
                      
                      // Log agent response als die er is
                      if (message.agent_response_event?.agent_response) {
                        console.log(
                          `[DEBUG] [ElevenLabs] Agent response in message:`,
                          message.agent_response_event.agent_response.substring(0, 150)
                        );
                      }
                    }

                    // ALLEERBELANGRIJKSTE: Check EERST voor end_call tool voordat we andere dingen doen
                    // MAAR: Negeer end_call als de agent alleen "Ik activeer" zegt zonder afsluiting!
                    let foundEndCall = false;

                    // Check alle mogelijke locaties voor end_call tool
                    const checkForEndCallTool = (obj) => {
                      if (!obj) return false;

                      // Direct in message root
                      if (obj.tool_calls) {
                        const toolCalls = Array.isArray(obj.tool_calls)
                          ? obj.tool_calls
                          : [obj.tool_calls];
                        for (const tc of toolCalls) {
                          if (tc.tool_name === "end_call") return true;
                        }
                      }

                      // In transcript array
                      if (obj.transcript && Array.isArray(obj.transcript)) {
                        for (const turn of obj.transcript) {
                          if (turn.tool_calls) {
                            const toolCalls = Array.isArray(turn.tool_calls)
                              ? turn.tool_calls
                              : [turn.tool_calls];
                            for (const tc of toolCalls) {
                              if (tc.tool_name === "end_call") return true;
                            }
                          }
                        }
                      }

                      // In agent_response_event
                      if (obj.agent_response_event?.tool_calls) {
                        const toolCalls = Array.isArray(
                          obj.agent_response_event.tool_calls
                        )
                          ? obj.agent_response_event.tool_calls
                          : [obj.agent_response_event.tool_calls];
                        for (const tc of toolCalls) {
                          if (tc.tool_name === "end_call") return true;
                        }
                      }

                      return false;
                    };

                    // CRITICAL: Check if this is a premature end_call (only "Ik activeer" without closing phrase)
                    // OF als er nog geen closing phrase is gedetecteerd
                    const hasPrematureEndCall = () => {
                      if (!checkForEndCallTool(message)) return false;

                      // Check BOTH the current message's agent response AND the last tracked response
                      const currentAgentText = (
                        message.agent_response_event?.agent_response || 
                        message.transcript?.[0]?.agent_response || 
                        ""
                      ).toLowerCase();
                      
                      const lastAgentText = lastAgentResponse.toLowerCase();
                      
                      // Combine both to check - use whichever is more recent/non-empty
                      const agentText = currentAgentText || lastAgentText;

                      // Check if agent said "Ik activeer" or similar
                      const hasAccountActivation =
                        agentText.includes("activeer") ||
                        agentText.includes("account activ") ||
                        agentText.includes("ik activeer");

                      // Check if there's een van de 4 toegestane closing phrases in the agent text
                      const closingPhrases = [
                        "nog een fijne dag",
                        "prettige dag",
                        "fijne dag",
                        "succes met uw accreditatie",
                      ];

                      const hasClosingPhrase = closingPhrases.some((phrase) =>
                        agentText.includes(phrase)
                      );

                      // KRITIEK: Het gesprek mag ALLEEN eindigen als één van de 4 toegestane closing phrases is gezegd
                      // ALLES anders wordt geblokkeerd, inclusief "Ik activeer" en andere end_call triggers
                      
                      // Check of er een closing phrase in de huidige of laatste agent response zit
                      const allowedClosingPhrases = [
                        "nog een fijne dag",
                        "prettige dag",
                        "fijne dag",
                        "succes met uw accreditatie",
                      ];
                      
                      const hasClosingPhraseInText = allowedClosingPhrases.some((phrase) =>
                        agentText.includes(phrase)
                      );
                      
                      // KRITIEKE CHECK: Het gesprek mag ALLEEN eindigen als closingPhraseDetected = true
                      // EN er moet een closing phrase in de huidige of laatste agent response zitten
                      // Dit betekent dat de bot EEN VAN DE 4 closing phrases heeft gezegd:
                      // - "Nog een fijne dag"
                      // - "Prettige dag"  
                      // - "Fijne dag"
                      // - "succes met uw accreditatie"
                      // 
                      // NIETS ANDERS mag het gesprek beëindigen!
                      
                      // DUBBELE CHECK: Zowel closingPhraseDetected flag ALS closing phrase in tekst
                      // Als één van beide ontbreekt → BLOKKEER
                      if (!closingPhraseDetected || !hasClosingPhraseInText) {
                        console.log(
                          "[ElevenLabs] ⚠️⚠️⚠️ PREMATURE end_call detected - BLOKKEER! ⚠️⚠️⚠️",
                          "Het gesprek mag ALLEEN eindigen na: 'Nog een fijne dag', 'Prettige dag', 'Fijne dag', of 'succes met uw accreditatie'",
                          "ClosingPhraseDetected:", closingPhraseDetected,
                          "HasClosingPhraseInText:", hasClosingPhraseInText,
                          "Current agent text:", currentAgentText.substring(0, 200),
                          "Last agent text:", lastAgentText.substring(0, 200),
                          "IGNORING end_call tool - BLOKKEER ALLES!"
                        );
                        return true; // This IS a premature end_call - ALTIJD BLOKKEEREN tenzij beide checks true zijn
                      }

                      // Alleen als closingPhraseDetected = true EN er zit een closing phrase in de tekst
                      console.log(
                        "[ElevenLabs] ✅ end_call tool ACCEPTED - closing phrase was detected",
                        "ClosingPhraseDetected:", closingPhraseDetected,
                        "HasClosingPhraseInText:", hasClosingPhraseInText
                      );
                      return false;
                    };

                    // Only process end_call if it's NOT premature
                    // EXTRA CHECK: Als er een closing phrase in de huidige message zit, zet closingPhraseDetected eerst op true
                    if (checkForEndCallTool(message)) {
                      // Check of er een closing phrase in de huidige message zit
                      const currentAgentText = (
                        message.agent_response_event?.agent_response || 
                        message.transcript?.[0]?.agent_response || 
                        ""
                      ).toLowerCase();
                      
                      const allowedClosingPhrases = [
                        "nog een fijne dag",
                        "prettige dag",
                        "fijne dag",
                        "succes met uw accreditatie",
                      ];
                      
                      const hasClosingPhraseInCurrentMessage = allowedClosingPhrases.some((phrase) =>
                        currentAgentText.includes(phrase)
                      );
                      
                      // Als er een closing phrase in de huidige message zit, zet closingPhraseDetected op true
                      if (hasClosingPhraseInCurrentMessage && !closingPhraseDetected) {
                        closingPhraseDetected = true;
                        console.log(
                          "[ElevenLabs] ✅ Closing phrase found in current message with end_call tool - setting closingPhraseDetected = true"
                        );
                      }
                    }
                    
                    if (
                      checkForEndCallTool(message) &&
                      !hasPrematureEndCall()
                    ) {
                      foundEndCall = true;
                      console.log(
                        "[ElevenLabs] ⚠️ end_call tool detected - will wait 20 seconds for bot to finish",
                        "ClosingPhraseDetected:", closingPhraseDetected
                      );

                      // Cancel any existing timers
                      if (closingPhraseTimer) clearTimeout(closingPhraseTimer);

                      // Give bot 20 seconds to finish speaking
                      closingPhraseTimer = setTimeout(() => {
                        const timeSinceLastAudio = Date.now() - lastAudioTime;
                        console.log(
                          `[ElevenLabs] After 20s delay - time since last audio: ${timeSinceLastAudio}ms`
                        );

                        // Als bot nog spreekt (audio binnen laatste 5 sec), wacht nog langer
                        if (timeSinceLastAudio < 5000) {
                          console.log(
                            "[ElevenLabs] Bot still speaking, waiting additional 8 seconds..."
                          );
                          setTimeout(() => {
                            const finalCheck = Date.now() - lastAudioTime;
                            console.log(
                              `[ElevenLabs] Final check - time since last audio: ${finalCheck}ms`
                            );

                            // Alleen hangup als bot echt klaar is (minimaal 3 sec stilte)
                            if (finalCheck >= 3000) {
                              safeEndCall("end_call tool (main check) - bot definitely finished", {
                                closingPhraseDetected,
                                timeSinceLastAudio: Date.now() - lastAudioTime
                              });
                            } else {
                              console.log(
                                "[ElevenLabs] Bot still speaking, waiting another 5 seconds..."
                              );
                              setTimeout(() => {
                                safeEndCall("end_call tool (main check) - extended wait", {
                                  closingPhraseDetected,
                                  timeSinceLastAudio: Date.now() - lastAudioTime
                                });
                              }, 5000);
                            }
                          }, 8000);
                        } else {
                          safeEndCall("end_call tool (main check) - bot stopped speaking", {
                            closingPhraseDetected,
                            timeSinceLastAudio: Date.now() - lastAudioTime
                          });
                        }
                      }, 20000); // 20 seconden - zeer ruim!

                      // Blijf audio doorsturen, maar start de closing timer
                      // Return niet - laat audio processing gewoon doorgaan
                    }

                    // Handle audio - forward to Twilio
                    if (message.type === "audio" && streamSid) {
                      const audioPayload = message.audio?.chunk || message.audio_event?.audio_base_64;
                      
                      // Log eerste paar audio chunks voor debugging
                      if (lastAudioTime === Date.now() || Date.now() - lastAudioTime > 5000) {
                        console.log(
                          "[DEBUG] [ElevenLabs] 📢 Audio received from ElevenLabs:",
                          "Has audio payload:", !!audioPayload,
                          "Payload length:", audioPayload ? audioPayload.length : 0,
                          "StreamSid:", streamSid
                        );
                      }
                      
                      if (!audioPayload) {
                        console.warn(
                          "[DEBUG] [ElevenLabs] ⚠️ Audio message but no payload found!",
                          "Message structure:",
                          JSON.stringify(message, null, 2).substring(0, 200)
                        );
                      }
                      
                      ws.send(
                        JSON.stringify({
                          event: "media",
                          streamSid,
                          media: {
                            payload: audioPayload,
                          },
                        })
                      );
                      updateActivity();
                      lastAudioTime = Date.now(); // Track wanneer laatste audio werd verstuurd
                      
                      // KRITIEK: Als closing phrase is gedetecteerd maar er komt nog audio binnen,
                      // reset de closing timer om te voorkomen dat het gesprek te vroeg eindigt
                      if (closingPhraseDetected && closingPhraseTimer) {
                        console.log(
                          "[DEBUG] ⚠️ Closing phrase detected but new audio received - resetting closing timer",
                          "TimeSinceLastAudio reset",
                          "Giving bot more time to finish speaking"
                        );
                        clearTimeout(closingPhraseTimer);
                        
                        // Reset de timer - wacht opnieuw tot er geen audio meer komt
                        closingPhraseTimer = setTimeout(() => {
                          const timeSinceLastAudio = Date.now() - lastAudioTime;
                          console.log(
                            "[DEBUG] Closing phrase timer reset triggered",
                            "TimeSinceLastAudio:", timeSinceLastAudio, "ms"
                          );
                          
                          if (timeSinceLastAudio < 5000) {
                            // Nog steeds audio binnen laatste 5 sec, wacht langer
                            setTimeout(() => {
                              safeEndCall("Closing phrase timer - bot finished speaking (after reset)", {
                                closingPhraseDetected,
                                timeSinceLastAudio: Date.now() - lastAudioTime,
                                phrase: "closing phrase"
                              });
                            }, 8000);
                          } else {
                            safeEndCall("Closing phrase timer - bot finished (after reset)", {
                              closingPhraseDetected,
                              timeSinceLastAudio: Date.now() - lastAudioTime,
                              phrase: "closing phrase"
                            });
                          }
                        }, 10000); // Wacht 10 seconden na laatste audio
                      }
                      
                      resetSilenceTimer();
                    }

                    // Handle agent response text
                    if (message.type === "agent_response") {
                      const text =
                        message.agent_response_event?.agent_response || "";
                      
                      console.log(
                        `[DEBUG] [Agent] 📝 FULL AGENT RESPONSE TEXT:`,
                        "Length:",
                        text.length,
                        "Full text:",
                        text,
                        "Timestamp:",
                        new Date().toISOString()
                      );
                      
                      console.log(`[Agent]: ${text}`);

                      // Track last agent response to detect premature end_call
                      lastAgentResponse = text;
                      
                      // DEBUG: Check of er een closing phrase in de tekst zit
                      const lowerText = text.toLowerCase();
                      const closingPhrases = [
                        "nog een fijne dag",
                        "prettige dag",
                        "fijne dag",
                        "succes met uw accreditatie",
                      ];
                      
                      const foundClosingPhrase = closingPhrases.find(phrase => 
                        lowerText.includes(phrase)
                      );
                      
                      if (foundClosingPhrase) {
                        console.log(
                          `[DEBUG] ✅ Closing phrase found in agent response: "${foundClosingPhrase}"`,
                          "Full text:", text.substring(0, 300)
                        );
                      } else {
                        console.log(
                          `[DEBUG] ⚠️ NO closing phrase found in agent response`,
                          "ClosingPhraseDetected:", closingPhraseDetected,
                          "Text:", text.substring(0, 200)
                        );
                      }

                      // Check ook voor tool_calls in agent_response (soms zit end_call hierin)
                      // KRITIEK: Ook hier moet de premature check worden toegepast!
                      if (message.agent_response_event?.tool_calls) {
                        for (const toolCall of message.agent_response_event
                          .tool_calls) {
                          if (toolCall.tool_name === "end_call") {
                            // KRITIEKE CHECK: Alleen accepteren als closingPhraseDetected = true EN er zit een closing phrase in de tekst
                            const allowedClosingPhrases = [
                              "nog een fijne dag",
                              "prettige dag",
                              "fijne dag",
                              "succes met uw accreditatie",
                            ];
                            
                            const hasClosingPhraseInText = allowedClosingPhrases.some((phrase) =>
                              text.toLowerCase().includes(phrase)
                            );
                            
                            if (!closingPhraseDetected || !hasClosingPhraseInText) {
                              console.log(
                                "[ElevenLabs] ⚠️⚠️⚠️ PREMATURE end_call in agent_response detected - BLOKKEER! ⚠️⚠️⚠️",
                                "Het gesprek mag ALLEEN eindigen na: 'Nog een fijne dag', 'Prettige dag', 'Fijne dag', of 'succes met uw accreditatie'",
                                "ClosingPhraseDetected:", closingPhraseDetected,
                                "HasClosingPhraseInText:", hasClosingPhraseInText,
                                "Agent text:", text.substring(0, 200),
                                "IGNORING end_call tool - BLOKKEER ALLES!"
                              );
                              return; // Stop processing - BLOKKEER de end_call
                            }
                            
                            console.log(
                              "[ElevenLabs] ✅ end_call tool in agent_response ACCEPTED - closing phrase was detected earlier"
                            );
                            if (closingPhraseTimer)
                              clearTimeout(closingPhraseTimer);
                            closingPhraseTimer = setTimeout(() => {
                              const timeSinceLastAudio =
                                Date.now() - lastAudioTime;
                              if (timeSinceLastAudio < 3000) {
                                setTimeout(() => {
                              safeEndCall("end_call tool in agent_response - bot finished", {
                                closingPhraseDetected,
                                timeSinceLastAudio: Date.now() - lastAudioTime
                              });
                                }, 5000);
                              } else {
                                safeEndCall("end_call tool in agent_response - bot stopped", {
                                  closingPhraseDetected,
                                  timeSinceLastAudio: Date.now() - lastAudioTime
                                });
                              }
                            }, 15000); // 15 seconden - geef bot meer tijd om af te ronden
                            return; // Stop processing this message
                          }
                        }
                      }

                      // Check voor closing phrases, maar BEINDIG NIET DIRECT
                      // Laat de bot zijn zin afmaken door alleen een timer te starten
                      
                      console.log(
                        `[DEBUG] [Agent] 🔍 Checking for closing phrase in text:`,
                        "Text length:",
                        text.length,
                        "Full text:",
                        text,
                        "Last 200 chars:",
                        text.substring(Math.max(0, text.length - 200))
                      );
                      
                      const closingPhraseFound = checkForClosingPhrase(text);
                      
                      // DEBUG: Log of closing phrase werd gevonden
                      if (closingPhraseFound) {
                        console.log(
                          `[DEBUG] ✅ checkForClosingPhrase returned TRUE - closing phrase detected`,
                          "ClosingPhraseDetected flag:",
                          closingPhraseDetected,
                          "Full text:",
                          text
                        );
                      } else {
                        console.log(
                          `[DEBUG] ⚠️ checkForClosingPhrase returned FALSE - no closing phrase found`,
                          "ClosingPhraseDetected flag:",
                          closingPhraseDetected,
                          "Text length:",
                          text.length,
                          "Full text:",
                          text,
                          "Last 200 chars:",
                          text.substring(Math.max(0, text.length - 200))
                        );
                      }

                      lastActivity = Date.now();
                      resetSilenceTimer();
                    }

                    // Handle tool calls (like end_call) - kan op verschillende plaatsen zitten
                    let toolCallsArray = [];

                    // Check verschillende locaties voor tool_calls
                    if (message.tool_calls) {
                      toolCallsArray = Array.isArray(message.tool_calls)
                        ? message.tool_calls
                        : [message.tool_calls];
                    } else if (
                      message.transcript &&
                      Array.isArray(message.transcript)
                    ) {
                      // Soms zitten tool_calls in transcript array
                      for (const turn of message.transcript) {
                        if (turn.tool_calls) {
                          toolCallsArray = toolCallsArray.concat(
                            Array.isArray(turn.tool_calls)
                              ? turn.tool_calls
                              : [turn.tool_calls]
                          );
                        }
                      }
                    } else if (message.transcript?.[0]?.tool_calls) {
                      toolCallsArray = Array.isArray(
                        message.transcript[0].tool_calls
                      )
                        ? message.transcript[0].tool_calls
                        : [message.transcript[0].tool_calls];
                    }

                    // Check alle gevonden tool_calls
                    // KRITIEK: Ook hier moet de premature check worden toegepast!
                    for (const toolCall of toolCallsArray) {
                      if (toolCall && toolCall.tool_name === "end_call") {
                        // KRITIEKE CHECK: Alleen accepteren als closingPhraseDetected = true EN er zit een closing phrase in de tekst
                        const currentAgentText = (
                          message.agent_response_event?.agent_response || 
                          message.transcript?.[0]?.agent_response || 
                          lastAgentResponse || 
                          ""
                        ).toLowerCase();
                        
                        const allowedClosingPhrases = [
                          "nog een fijne dag",
                          "prettige dag",
                          "fijne dag",
                          "succes met uw accreditatie",
                        ];
                        
                        const hasClosingPhraseInText = allowedClosingPhrases.some((phrase) =>
                          currentAgentText.includes(phrase)
                        );
                        
                        if (!closingPhraseDetected || !hasClosingPhraseInText) {
                          console.log(
                            "[ElevenLabs] ⚠️⚠️⚠️ PREMATURE end_call in tool_calls array detected - BLOKKEER! ⚠️⚠️⚠️",
                            "Het gesprek mag ALLEEN eindigen na: 'Nog een fijne dag', 'Prettige dag', 'Fijne dag', of 'succes met uw accreditatie'",
                            "ClosingPhraseDetected:", closingPhraseDetected,
                            "HasClosingPhraseInText:", hasClosingPhraseInText,
                            "Current agent text:", currentAgentText.substring(0, 200),
                            "IGNORING end_call tool - BLOKKEER ALLES!"
                          );
                          return; // Stop processing - BLOKKEER de end_call
                        }
                        
                        console.log(
                          "[ElevenLabs] ✅ end_call tool in tool_calls array ACCEPTED - closing phrase was detected earlier",
                          "waiting 15 seconds before hanging up to let bot finish speaking"
                        );

                        // Cancel any existing closing timers
                        if (closingPhraseTimer)
                          clearTimeout(closingPhraseTimer);

                        // Give bot 15 seconds to finish speaking after end_call tool
                        closingPhraseTimer = setTimeout(() => {
                          const timeSinceLastAudio = Date.now() - lastAudioTime;
                          console.log(
                            `[ElevenLabs] Time since last audio: ${timeSinceLastAudio}ms`
                          );

                          // Als bot nog spreekt (audio binnen laatste 5 sec), wacht langer
                          if (timeSinceLastAudio < 5000) {
                            console.log(
                              "[ElevenLabs] Bot still speaking after end_call, waiting additional 5 seconds..."
                            );
                            setTimeout(() => {
                              const finalTimeSinceAudio =
                                Date.now() - lastAudioTime;
                              console.log(
                                `[ElevenLabs] Final check - time since last audio: ${finalTimeSinceAudio}ms`
                              );
                            safeEndCall("end_call tool in tool_calls array - bot finished", {
                              closingPhraseDetected,
                              timeSinceLastAudio: Date.now() - lastAudioTime
                            });
                            }, 5000);
                          } else {
                            safeEndCall("end_call tool in tool_calls array - bot stopped", {
                              closingPhraseDetected,
                              timeSinceLastAudio: Date.now() - lastAudioTime
                            });
                          }
                        }, 15000); // 15 seconden delay na end_call tool - meer tijd!
                        return; // Stop processing further message handlers
                      }
                    }

                    // Handle conversation end event
                    // KRITIEK: conversation_end mag ALLEEN het gesprek beëindigen als één van de 4 closing phrases is gezegd
                    if (
                      message.type === "conversation_end" ||
                      message.termination_reason
                    ) {
                      if (!closingPhraseDetected) {
                        console.log(
                          `[ElevenLabs] ⚠️ Conversation end detected but NO closing phrase found - IGNORING!`,
                          "Het gesprek mag ALLEEN eindigen na: 'Nog een fijne dag', 'Prettige dag', 'Fijne dag', of 'succes met uw accreditatie'",
                          "Reason:", message.termination_reason || message.conversation_end_event?.reason || "unknown"
                        );
                        // Niet beëindigen - wachten op closing phrase
                        return;
                      }

                      const reason =
                        message.termination_reason ||
                        message.conversation_end_event?.reason ||
                        "unknown";
                      console.log(
                        `[ElevenLabs] Conversation end detected: ${reason} - closing phrase was detected, waiting 10 seconds before hanging up`
                      );

                      // Cancel any existing timers
                      if (closingPhraseTimer) clearTimeout(closingPhraseTimer);

                      closingPhraseTimer = setTimeout(() => {
                        const timeSinceLastAudio = Date.now() - lastAudioTime;
                        if (timeSinceLastAudio < 3000) {
                          setTimeout(() => {
                            safeEndCall("conversation_end event - bot finished", {
                              closingPhraseDetected,
                              timeSinceLastAudio: Date.now() - lastAudioTime,
                              reason: message.termination_reason || message.conversation_end_event?.reason || "unknown"
                            });
                          }, 5000);
                        } else {
                          safeEndCall("conversation_end event - bot stopped", {
                            closingPhraseDetected,
                            timeSinceLastAudio: Date.now() - lastAudioTime,
                            reason: message.termination_reason || message.conversation_end_event?.reason || "unknown"
                          });
                        }
                      }, 10000); // 10 seconden delay
                      return;
                    }

                    // Handle user transcript
                    if (message.type === "user_transcript") {
                      console.log(
                        `[User]: ${message.user_transcription_event?.user_transcript}`
                      );
                      lastActivity = Date.now();
                      resetSilenceTimer();
                    }
                  } catch (error) {
                    console.error(
                      "[DEBUG] [ElevenLabs] ❌ ERROR in message handler:",
                      error.message || error,
                      "Stack:",
                      error.stack?.substring(0, 500)
                    );
                    console.error("[ElevenLabs] Error details:", error);
                  }
                });
              } catch (error) {
                console.error("[ElevenLabs] Setup error:", error);
              }
              resetSilenceTimer();
              break;

            case "media":
              // Stop met verwerken van audio als call wordt beëindigd
              if (callEnding) {
                console.log(
                  "[DEBUG] [Twilio] ⏸️ Ignoring audio - call is ending",
                  "StreamSid:", streamSid,
                  "CallSid:", callSid
                );
                break; // Stop met verwerken van deze audio
              }
              
              // FALLBACK: Als we media ontvangen maar nog geen ElevenLabs verbinding hebben,
              // probeer de verbinding alsnog op te zetten (als "start" event niet werd ontvangen)
              if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN || !elevenLabsReady) {
                if (!elevenLabsSetupAttempted && callSid) {
                  elevenLabsSetupAttempted = true; // Voorkom meerdere pogingen
                  console.log(
                    "[DEBUG] [ElevenLabs] ⚠️ FALLBACK: Media received but ElevenLabs not connected",
                    "Attempting to setup connection now...",
                    "CallSid:", callSid,
                    "StreamSid:", streamSid || "UNKNOWN"
                  );
                  
                  // Probeer agent_id te halen uit customParameters of gebruik default
                  // Default agent_id uit ELEVENLABS-SETUP.md: agent_6001k7v9jf03ecnvgk57qvkfdx4
                  const agentId = customParameters?.agent_id || customParameters?.agentId || process.env.DEFAULT_AGENT_ID || "agent_6001k7v9jf03ecnvgk57qvkfdx4";
                  
                  if (agentId) {
                    console.log(
                      "[DEBUG] [ElevenLabs] 🔄 FALLBACK: Setting up ElevenLabs with agent_id:",
                      agentId
                    );
                    
                    // Setup ElevenLabs verbinding (gebruik dezelfde code als in "start" case)
                    (async () => {
                      try {
                        const signedUrl = await getSignedUrl(agentId);
                        console.log("[DEBUG] [ElevenLabs] ✅ FALLBACK: Got signed URL");
                        elevenLabsWs = new WebSocket(signedUrl);
                        
                        elevenLabsWs.on("open", () => {
                          console.log(
                            "[DEBUG] [ElevenLabs] ✅ FALLBACK: Connected to Conversational AI WebSocket",
                            "StreamSid:", streamSid,
                            "CallSid:", callSid
                          );
                          
                          let prompt = customParameters?.prompt || "You are a helpful assistant";
                          let firstMessage = customParameters?.first_message || "";
                          
                          const contactId = customParameters?.contact_id || customParameters?.contactId || null;
                          const campaignId = customParameters?.campaign_id || customParameters?.campaignId || null;
                          
                          const replaceVariables = (text) => {
                            if (!text) return text;
                            return text
                              .replace(/\{\{call_sid\}\}/g, callSid || '')
                              .replace(/\{\{contact_id\}\}/g, contactId || '')
                              .replace(/\{\{campaign_id\}\}/g, campaignId || '');
                          };
                          
                          prompt = replaceVariables(prompt);
                          firstMessage = replaceVariables(firstMessage);
                          
                          const initialConfig = {
                            type: "conversation_initiation_client_data",
                            conversation_config_override: {
                              agent: {
                                prompt: { prompt },
                                first_message: firstMessage,
                              },
                              metadata: {
                                call_sid: callSid,
                                contact_id: contactId || null,
                                campaign_id: campaignId || null,
                              },
                            },
                          };
                          
                          elevenLabsWs.send(JSON.stringify(initialConfig));
                          console.log("[DEBUG] [ElevenLabs] ✅ FALLBACK: Initial config sent");
                          elevenLabsReady = true;
                          
                          // Process buffered audio
                          while (audioBuffer.length > 0 && !callEnding) {
                            const bufferedAudio = audioBuffer.shift();
                            if (elevenLabsWs?.readyState === WebSocket.OPEN && !callEnding) {
                              elevenLabsWs.send(
                                JSON.stringify({
                                  user_audio_chunk: Buffer.from(
                                    bufferedAudio.payload,
                                    "base64"
                                  ).toString("base64"),
                                })
                              );
                            }
                          }
                        });
                        
                        elevenLabsWs.on("error", (error) => {
                          console.error(
                            "[DEBUG] [ElevenLabs] ❌ FALLBACK: WebSocket error:",
                            error.message || error
                          );
                        });
                        
                        elevenLabsWs.on("close", (code, reason) => {
                          console.log(
                            "[DEBUG] [ElevenLabs] 🚨 FALLBACK: WebSocket CLOSED:",
                            "Code:", code,
                            "Reason:", reason?.toString() || "No reason provided"
                          );
                          elevenLabsReady = false;
                        });
                      } catch (error) {
                        console.error(
                          "[DEBUG] [ElevenLabs] ❌ FALLBACK: Setup error:",
                          error.message
                        );
                      }
                    })();
                  } else {
                    console.error(
                      "[DEBUG] [ElevenLabs] ❌ FALLBACK: No agent_id available, cannot setup connection"
                    );
                  }
                }
                
                // Buffer audio terwijl we wachten op ElevenLabs verbinding
                if (msg.media && msg.media.payload) {
                  audioBuffer.push({
                    payload: msg.media.payload,
                    timestamp: Date.now(),
                  });
                  if (audioBuffer.length > 50) {
                    audioBuffer.shift(); // Remove oldest if buffer too large
                  }
                  console.log(
                    "[DEBUG] [Twilio] ⏳ Buffering audio - ElevenLabs not ready yet",
                    "ReadyState:", elevenLabsWs?.readyState,
                    "ElevenLabsReady:", elevenLabsReady,
                    "StreamSid:", streamSid,
                    "Buffer size:", audioBuffer.length
                  );
                }
                break; // Stop processing deze media chunk tot ElevenLabs klaar is
              }
              
              if (elevenLabsWs?.readyState === WebSocket.OPEN && elevenLabsReady) {
                // Log eerste paar media chunks voor debugging
                if (Date.now() - lastActivity > 5000 || lastActivity === Date.now()) {
                  console.log(
                    "[DEBUG] [Twilio] 📢 Audio received from Twilio (user speaking):",
                    "Payload length:", msg.media.payload ? msg.media.payload.length : 0,
                    "StreamSid:", streamSid,
                    "ElevenLabs connected:", elevenLabsWs?.readyState === WebSocket.OPEN,
                    "ElevenLabs ready:", elevenLabsReady
                  );
                }
                
                elevenLabsWs.send(
                  JSON.stringify({
                    user_audio_chunk: Buffer.from(
                      msg.media.payload,
                      "base64"
                    ).toString("base64"),
                  })
                );
                updateActivity();
                resetSilenceTimer();
              } else {
                // Stop met bufferen als call wordt beëindigd
                if (callEnding) {
                  console.log(
                    "[DEBUG] [Twilio] ⏸️ Ignoring audio - call is ending",
                    "StreamSid:", streamSid,
                    "CallSid:", callSid
                  );
                  break; // Stop met verwerken van deze audio
                }
                
                // Buffer audio if ElevenLabs is not ready yet
                console.log(
                  "[DEBUG] [Twilio] ⏳ Buffering audio - ElevenLabs not ready yet",
                  "ReadyState:", elevenLabsWs?.readyState,
                  "ElevenLabsReady:", elevenLabsReady,
                  "StreamSid:", streamSid,
                  "Buffer size:", audioBuffer.length
                );
                
                // Buffer the audio chunk
                audioBuffer.push({
                  payload: msg.media.payload,
                  timestamp: Date.now(),
                });
                
                // Limit buffer size to prevent memory issues (keep last 50 chunks)
                if (audioBuffer.length > 50) {
                  console.warn(
                    "[DEBUG] [Twilio] ⚠️ Audio buffer too large, removing oldest chunks",
                    "Buffer size:", audioBuffer.length
                  );
                  audioBuffer = audioBuffer.slice(-50); // Keep last 50 chunks
                }
                
                lastActivity = Date.now();
                resetSilenceTimer();
              }
              break;

            case "stop":
              console.log(
                "[DEBUG] [Twilio] 🚨 Stream stop event received",
                "StreamSid:",
                streamSid,
                "CallSid:",
                callSid,
                "ClosingPhraseDetected:",
                closingPhraseDetected,
                "LastAgentResponse:",
                lastAgentResponse.substring(0, 100)
              );
              
              // KRITIEK: Check of dit een premature stop is
              if (!closingPhraseDetected) {
                console.log(
                  "[DEBUG] 🚫 BLOCKED STOP EVENT - NO CLOSING PHRASE! 🚫",
                  "Het gesprek mag ALLEEN eindigen na: 'Nog een fijne dag', 'Prettige dag', 'Fijne dag', of 'succes met uw accreditatie'",
                  "ClosingPhraseDetected:",
                  closingPhraseDetected
                );
                // Blokkeer de stop - probeer het gesprek te hervatten
                // Dit is waarschijnlijk een premature stop van Twilio
                return; // Stop processing maar sluit de websocket niet
              }
              
              if (silenceTimer) clearTimeout(silenceTimer);
              if (closingPhraseTimer) clearTimeout(closingPhraseTimer);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;
          }
        } catch (error) {
          console.error(
            "[DEBUG] [Twilio] ❌ ERROR in message handler:",
            error.message || error,
            "Stack:",
            error.stack?.substring(0, 500)
          );
          console.error("[Twilio] Error details:", error);
        }
      });

      ws.on("close", () => {
        console.log(
          "[DEBUG] [Twilio] 🚨 Client disconnected (close event)",
          "ClosingPhraseDetected:",
          closingPhraseDetected,
          "StreamSid:",
          streamSid,
          "CallSid:",
          callSid,
          "LastAgentResponse:",
          lastAgentResponse.substring(0, 100)
        );
        if (silenceTimer) clearTimeout(silenceTimer);
        if (closingPhraseTimer) clearTimeout(closingPhraseTimer);
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
      
      ws.on("error", (error) => {
        console.error(
          "[DEBUG] [Twilio] ❌ WebSocket error:",
          error.message || error,
          "ClosingPhraseDetected:",
          closingPhraseDetected,
          "StreamSid:",
          streamSid
        );
      });
    }
  );

// Start server
fastify.listen({ port: PORT, host: "0.0.0.0" }, async (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] RIZIV Outbound Calling Server running on port ${PORT}`);
  console.log(`[Server] WebSocket endpoint: wss://voicebot-w8gx.onrender.com/campaign-media-stream`);
  console.log(`[Server] Health check: https://voicebot-w8gx.onrender.com/`);
  
  // Check critical environment variables
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error(`[Server] ❌ CRITICAL: ELEVENLABS_API_KEY is not set!`);
    console.error(`[Server] ElevenLabs WebSocket connections will fail without this key.`);
  } else {
    console.log(`[Server] ✅ ELEVENLABS_API_KEY is set (length: ${process.env.ELEVENLABS_API_KEY.length} chars)`);
  }
  
  console.log(`[Server] Ready to handle ElevenLabs calls`);
  
  // Debug: List all registered routes
  try {
    const routes = fastify.printRoutes();
    console.log(`[Server] Registered routes:`, routes);
  } catch (e) {
    console.log(`[Server] Could not print routes:`, e.message);
  }
});
