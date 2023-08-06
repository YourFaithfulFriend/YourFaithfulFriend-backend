const { v4 } = require("uuid");

// Google Speech to text
const { SpeechClient } = require("@google-cloud/speech");

const googleSpeechClient = new SpeechClient();

// Google TTS
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");

const googleTTSClient = new TextToSpeechClient();

// Google OAuth2
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client();

// OpenAI
const { Configuration, OpenAIApi } = require("openai");

const config = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openAIClient = new OpenAIApi(config);

const startingPrompt = `You are a helpful friend who is dealing with the user for a mental health application. You are giving them advice on how to feel better and seek treatment. Speak as if you can relate to the user. Offer advice to their situation and give them calls for action. Respond with 10-30 words. `;

// MongoDB
const { MongoClient, ServerApiVersion } = require("mongodb");

const mongoClient = new MongoClient(process.env.MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const db = mongoClient.db(process.env.DATABASE_NAME);
const usersCollection = db.collection("Users");
const conversationsCollection = db.collection("Conversations");

// Express
const express = require("express");
const cors = require("cors");
const pino = require("express-pino-logger")();

const app = express();
app.use(express.json());
app.use(cors());
app.use(pino);

app.get("/", (req, res) => {
  res.sendStatus(200);
});

app.post("/api/login", async (req, res) => {
  const credential = req.query.credential;

  // No ?credential=xxx
  if (!credential) {
    return res.status(400).send("Credential missing.");
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.REACT_APP_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error) {
    return res.status(400).send(error);
  }

  if (!payload) {
    return res.status(400).send("No account payload!");
  }

  usersCollection.updateOne(
    { _id: payload.sub },
    { $set: { _id: payload.sub, ...payload } },
    { upsert: true }
  );

  return res.json(payload);
});

app.post("/api/createConversation", async (req, res) => {
  const initialMessage = req.query.message;

  if (!initialMessage) {
    return res.status(400).send('Missing "message" parameter');
  }

  const userId = req.query.sub;

  if (!userId) {
    return res.status(400).send('Missing "sub" parameter');
  }

  let completionResult;
  try {
    completionResult = await openAIClient.createChatCompletion({
      model: "gpt-3.5-turbo-16k-0613",
      messages: [
        {
          role: "system",
          content: startingPrompt,
        },
        {
          role: "user",
          content: initialMessage,
        },
      ],
      temperature: 0.05,
      max_tokens: 200
    });
  } catch (error) {
    console.error(error);
    res.status(400).send(`An error occured in relation to OpenAI: ${error}`);
  }

  const botResponse = completionResult.data.choices[0].message.content;

  const conversation = {
    id: v4(),
    messages: [
      {
        role: "user",
        content: initialMessage,
      },
      {
        role: "assistant",
        content: botResponse,
      },
    ],
    lastTimestamp: Math.floor(Date.now() / 1000),
    userId: userId,
  };

  await conversationsCollection.insertOne(conversation);

  return res.json(conversation);
});

app.post("/api/message", async (req, res) => {
  const conversationId = req.query.conversation;

  if (!conversationId) {
    return res.status(400).send('Missing "conversation" parameter');
  }

  const userMessage = req.query.message;

  if (!userMessage) {
    return res.status(400).send('Missing "message" parameter');
  }

  const conversation = await conversationsCollection.findOne({
    id: conversationId,
  });

  if (!conversation) {
    return res.status(400).send("Failed to find conversation by ID!");
  }

  let completionResult;
  try {
    completionResult = await openAIClient.createChatCompletion({
      model: "gpt-3.5-turbo-16k-0613",
      messages: [
        {
          role: "system",
          content: startingPrompt,
        },
        ...conversation.messages,
        {
          role: "user",
          content: userMessage,
        },
      ],
      temperature: 0.05,
      max_tokens: 200
    });
  } catch (error) {
    console.error(error);
    res.status(400).send(`An error occured in relation to OpenAI: ${error}`);
  }

  const botResponse = completionResult.data.choices[0].message.content;

  let newConversation = {
    ...conversation,
    lastTimestamp: Math.floor(Date.now() / 1000),
  };
  newConversation.messages = [
    ...newConversation.messages,
    { role: "user", content: userMessage },
    { role: "assistant", content: botResponse },
  ];

  // Update conversation in MongoDB
  await conversationsCollection.updateOne(
    { id: conversationId },
    { $set: newConversation }
  );

  // Send new conversation
  return res.json(newConversation);
});

app.get("/api/listConversations", async (req, res) => {
  const userId = req.query.sub;

  if (!userId) {
    return res.status(400).send('Missing "sub" parameter');
  }

  const conversations = await conversationsCollection
    .find({ userId: userId })
    .toArray();
  return res.json(conversations);
});

app.get("/api/tts", async (req, res) => {
  try {
    const text = req.query.text; // Get the "text" parameter from the query string

    if (!text) {
      return res.status(400).send('Missing "text" parameter');
    }

    const request = {
      input: {
        text: text,
      },
      voice: {
        languageCode: "en-US",
        ssmlGender: "NEUTRAL",
      },
      audioConfig: {
        audioEncoding: "MP3",
      },
    };

    const [response] = await googleTTSClient.synthesizeSpeech(request);

    res.set("Content-Type", "audio/mpeg");
    res.send(response.audioContent);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("An error occurred at Google TTS.");
  }
});

app.post("/api/stt", async (req, res) => {
  try {
    const audioBytes = req.body.audioContent; // Assuming the audio content is sent in the request body

    if (!audioBytes) {
      return res.status(400).send("Missing audio content.");
    }

    const audio = { content: audioBytes };
    const config = {
      encoding: "MP3", // Adjust this based on the actual audio encoding
      sampleRateHertz: 16000,
      languageCode: "en-US",
    };
    const request = {
      audio: audio,
      config: config,
    };

    const [response] = await googleSpeechClient.recognize(request);
    const transcription = response.results
      .map((result) => result.alternatives[0].transcript)
      .join("\n");
    res.send(transcription);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("An error occurred at Google SST.");
  }
});

app.listen(8080, () =>
  console.log("Express server is running on localhost:8080")
);
