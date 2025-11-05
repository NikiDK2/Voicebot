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
  fastifyInstance.get(
    "/campaign-media-stream",
    { websocket: true },
    (connection, req) => {
      console.log("[Server] Twilio connected to campaign media stream");
      const ws = connection.socket;

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;
      let silenceTimer = null;
      let closingPhraseTimer = null;
      let lastActivity = Date.now();
      let lastAudioTime = Date.now();
      let closingPhraseDetected = false;
      let lastAgentResponse = ""; // Track laatste agent response om premature end_call te detecteren

      ws.on("error", console.error);

      // Function to reset silence timer (verhoogd naar 25 seconden voor meer geduld)
      const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          console.log("[Twilio] No activity for 25 seconds, hanging up call");
          if (streamSid) {
            ws.send(JSON.stringify({ event: "stop", streamSid }));
          }
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
          }
          ws.close();
        }, 25000); // 25 seconden - geeft veel meer tijd voor vragen/luisteren
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
          if (lowerText.includes(phrase)) {
            // Als we nog geen closing phrase hebben gedetecteerd, start timer
            if (!closingPhraseDetected) {
              closingPhraseDetected = true;
              console.log(
                `[ElevenLabs] Closing phrase detected: "${phrase}", will hang up in 10 seconds to let bot finish`
              );

              // Clear eventuele bestaande closing timer
              if (closingPhraseTimer) clearTimeout(closingPhraseTimer);

              // Wacht minimaal 10 seconden zodat de bot zijn zin kan afmaken
              closingPhraseTimer = setTimeout(() => {
                // Check of er recent nog audio is geweest (bot spreekt nog)
                const timeSinceLastAudio = Date.now() - lastAudioTime;

                // Als er in de laatste 3 seconden nog audio was, wacht nog langer
                if (timeSinceLastAudio < 3000) {
                  console.log(
                    "[ElevenLabs] Bot still speaking, waiting additional 5 seconds..."
                  );
                  setTimeout(() => {
                    console.log(
                      "[ElevenLabs] Closing call after bot finished speaking"
                    );
                    if (streamSid) {
                      ws.send(JSON.stringify({ event: "stop", streamSid }));
                    }
                    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                      elevenLabsWs.close();
                    }
                    ws.close();
                  }, 5000);
                } else {
                  // Bot is klaar met praten, sluit de call
                  console.log(
                    "[ElevenLabs] Closing call - bot finished speaking (minimaal 10 seconden gewacht)"
                  );
                  if (streamSid) {
                    ws.send(JSON.stringify({ event: "stop", streamSid }));
                  }
                  if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                    elevenLabsWs.close();
                  }
                  ws.close();
                }
              }, 10000); // Minimaal 10 seconden delay om bot zijn zin te laten afmaken
            }
            return true; // Closing phrase gevonden, maar hang up gebeurt pas na delay
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
                  const prompt =
                    customParameters?.prompt || "You are a helpful assistant";
                  const firstMessage = customParameters?.first_message || "";
                  const initialConfig = {
                    type: "conversation_initiation_client_data",
                    conversation_config_override: {
                      agent: {
                        prompt: { prompt },
                        first_message: firstMessage,
                      },
                    },
                  };
                  elevenLabsWs.send(JSON.stringify(initialConfig));
                });

                elevenLabsWs.on("message", (data) => {
                  try {
                    const message = JSON.parse(data);

                    // Log alle message types voor debugging (behalve audio om spam te voorkomen)
                    if (message.type !== "audio") {
                      console.log(`[ElevenLabs] Message type: ${message.type}`);
                      // Log ook of er tool_calls in zitten
                      if (
                        message.tool_calls ||
                        message.transcript?.[0]?.tool_calls ||
                        message.agent_response_event?.tool_calls
                      ) {
                        console.log(
                          `[ElevenLabs] Message contains tool_calls - logging structure`
                        );
                        console.log(
                          JSON.stringify(message, null, 2).substring(0, 500)
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
                      
                      // Als er GEEN closing phrase is gedetecteerd → ALTIJD blokkeren
                      if (!closingPhraseDetected) {
                        console.log(
                          "[ElevenLabs] ⚠️ PREMATURE end_call detected - NO closing phrase found yet!",
                          "Het gesprek mag ALLEEN eindigen na: 'Nog een fijne dag', 'Prettige dag', 'Fijne dag', of 'succes met uw accreditatie'",
                          "IGNORING end_call tool!",
                          "Current agent text:", currentAgentText.substring(0, 150),
                          "Last agent text:", lastAgentText.substring(0, 150),
                          "ClosingPhraseDetected:", closingPhraseDetected
                        );
                        return true; // This IS a premature end_call - BLOKKEER alles behalve de 4 toegestane closing phrases
                      }

                      // Als closingPhraseDetected al true is, dan is het OK om te eindigen
                      return false;
                    };

                    // Only process end_call if it's NOT premature
                    if (
                      checkForEndCallTool(message) &&
                      !hasPrematureEndCall()
                    ) {
                      foundEndCall = true;
                      console.log(
                        "[ElevenLabs] ⚠️ end_call tool detected - will wait 20 seconds for bot to finish"
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
                              console.log(
                                "[ElevenLabs] Hanging up after end_call (bot definitely finished)"
                              );
                              if (streamSid)
                                ws.send(
                                  JSON.stringify({ event: "stop", streamSid })
                                );
                              if (elevenLabsWs?.readyState === WebSocket.OPEN)
                                elevenLabsWs.close();
                              ws.close();
                            } else {
                              console.log(
                                "[ElevenLabs] Bot still speaking, waiting another 5 seconds..."
                              );
                              setTimeout(() => {
                                console.log(
                                  "[ElevenLabs] Hanging up after extended wait"
                                );
                                if (streamSid)
                                  ws.send(
                                    JSON.stringify({ event: "stop", streamSid })
                                  );
                                if (elevenLabsWs?.readyState === WebSocket.OPEN)
                                  elevenLabsWs.close();
                                ws.close();
                              }, 5000);
                            }
                          }, 8000);
                        } else {
                          console.log(
                            "[ElevenLabs] Hanging up after end_call (bot stopped speaking)"
                          );
                          if (streamSid)
                            ws.send(
                              JSON.stringify({ event: "stop", streamSid })
                            );
                          if (elevenLabsWs?.readyState === WebSocket.OPEN)
                            elevenLabsWs.close();
                          ws.close();
                        }
                      }, 20000); // 20 seconden - zeer ruim!

                      // Blijf audio doorsturen, maar start de closing timer
                      // Return niet - laat audio processing gewoon doorgaan
                    }

                    // Handle audio - forward to Twilio
                    if (message.type === "audio" && streamSid) {
                      ws.send(
                        JSON.stringify({
                          event: "media",
                          streamSid,
                          media: {
                            payload:
                              message.audio?.chunk ||
                              message.audio_event?.audio_base_64,
                          },
                        })
                      );
                      lastActivity = Date.now();
                      lastAudioTime = Date.now(); // Track wanneer laatste audio werd verstuurd
                      resetSilenceTimer();
                    }

                    // Handle agent response text
                    if (message.type === "agent_response") {
                      const text =
                        message.agent_response_event?.agent_response || "";
                      console.log(`[Agent]: ${text}`);

                      // Track last agent response to detect premature end_call
                      lastAgentResponse = text;

                      // Check ook voor tool_calls in agent_response (soms zit end_call hierin)
                      if (message.agent_response_event?.tool_calls) {
                        for (const toolCall of message.agent_response_event
                          .tool_calls) {
                          if (toolCall.tool_name === "end_call") {
                            console.log(
                              "[ElevenLabs] end_call tool in agent_response detected - waiting 12 seconds"
                            );
                            if (closingPhraseTimer)
                              clearTimeout(closingPhraseTimer);
                            closingPhraseTimer = setTimeout(() => {
                              const timeSinceLastAudio =
                                Date.now() - lastAudioTime;
                              if (timeSinceLastAudio < 3000) {
                                setTimeout(() => {
                                  console.log(
                                    "[ElevenLabs] Hanging up after end_call (agent_response, bot finished)"
                                  );
                                  if (streamSid)
                                    ws.send(
                                      JSON.stringify({
                                        event: "stop",
                                        streamSid,
                                      })
                                    );
                                  if (
                                    elevenLabsWs?.readyState === WebSocket.OPEN
                                  )
                                    elevenLabsWs.close();
                                  ws.close();
                                }, 5000);
                              } else {
                                console.log(
                                  "[ElevenLabs] Hanging up after end_call (agent_response)"
                                );
                                if (streamSid)
                                  ws.send(
                                    JSON.stringify({ event: "stop", streamSid })
                                  );
                                if (elevenLabsWs?.readyState === WebSocket.OPEN)
                                  elevenLabsWs.close();
                                ws.close();
                              }
                            }, 15000); // 15 seconden - geef bot meer tijd om af te ronden
                            return; // Stop processing this message
                          }
                        }
                      }

                      // Check voor closing phrases, maar BEINDIG NIET DIRECT
                      // Laat de bot zijn zin afmaken door alleen een timer te starten
                      checkForClosingPhrase(text);

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
                    for (const toolCall of toolCallsArray) {
                      if (toolCall && toolCall.tool_name === "end_call") {
                        console.log(
                          "[ElevenLabs] end_call tool detected - waiting 12 seconds before hanging up to let bot finish speaking"
                        );

                        // Cancel any existing closing timers
                        if (closingPhraseTimer)
                          clearTimeout(closingPhraseTimer);

                        // Give bot 12 seconds to finish speaking after end_call tool
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
                              console.log(
                                "[ElevenLabs] Hanging up after end_call tool (bot finished)"
                              );
                              if (streamSid) {
                                ws.send(
                                  JSON.stringify({ event: "stop", streamSid })
                                );
                              }
                              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                                elevenLabsWs.close();
                              }
                              ws.close();
                            }, 5000);
                          } else {
                            console.log(
                              "[ElevenLabs] Hanging up after end_call tool (bot stopped speaking)"
                            );
                            if (streamSid) {
                              ws.send(
                                JSON.stringify({ event: "stop", streamSid })
                              );
                            }
                            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                              elevenLabsWs.close();
                            }
                            ws.close();
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
                            console.log(
                              "[ElevenLabs] Hanging up after conversation_end (bot finished)"
                            );
                            if (streamSid) {
                              ws.send(
                                JSON.stringify({ event: "stop", streamSid })
                              );
                            }
                            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                              elevenLabsWs.close();
                            }
                            ws.close();
                          }, 5000);
                        } else {
                          console.log(
                            "[ElevenLabs] Hanging up after conversation_end"
                          );
                          if (streamSid) {
                            ws.send(
                              JSON.stringify({ event: "stop", streamSid })
                            );
                          }
                          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                            elevenLabsWs.close();
                          }
                          ws.close();
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
                elevenLabsWs.send(
                  JSON.stringify({
                    user_audio_chunk: Buffer.from(
                      msg.media.payload,
                      "base64"
                    ).toString("base64"),
                  })
                );
                lastActivity = Date.now();
                resetSilenceTimer();
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (silenceTimer) clearTimeout(silenceTimer);
              if (closingPhraseTimer) clearTimeout(closingPhraseTimer);
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
        if (closingPhraseTimer) clearTimeout(closingPhraseTimer);
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] RIZIV Outbound Calling Server running on port ${PORT}`);
});
