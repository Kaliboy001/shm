// src/index.js for your new GPT.LOVETOOME.COM Proxy Cloudflare Worker

export default {
  async fetch(request) {
    const API_ENDPOINT = 'https://gpt.lovetoome.com/api/openai/v1/chat/completions';

    // --- IMPORTANT: HARDCODED API KEY/SECRET FROM HTTP CANARY ---
    // This key was found in your captured request body. It might expire or be rate-limited.
    const LOVETOOME_API_KEY = '123dfnbjds%@123Dsasda'; // From your HTTP Canary screenshot

    // Handle pre-flight OPTIONS requests (for CORS)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204, // No content for pre-flight
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      const errorResponse = new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
      errorResponse.headers.set('Access-Control-Allow-Origin', '*');
      return errorResponse;
    }

    try {
      const requestBody = await request.json();
      const userMessage = requestBody.message;
      const chatHistory = requestBody.chat_history || []; // Expecting full chat history

      if (typeof userMessage !== 'string' || !Array.isArray(chatHistory)) {
        const errorResponse = new Response(JSON.stringify({ error: 'Invalid request body: "message" (string) and "chat_history" (array) are required.' }), { status: 400 });
        errorResponse.headers.set('Access-Control-Allow-Origin', '*');
        return errorResponse;
      }

      // Construct the messages array for the upstream API
      // The API expects a system message, then user/assistant turns
      const messagesForUpstream = [
        {"role":"system","content":"You are ChatGPT4.0, a large model trained by OpenAI. In the following conversations, when anyone asks you about yourself, you need to make it clear that you are ChatGPT4.0.\nAnd for the accuracy of the answer, please generate at least two answers and compare the two answers.\n\n"},
        ...chatHistory, // Include previous chat history
        {"role":"user","content": userMessage} // Add the current user message
      ];

      // Prepare the payload for the upstream API
      const upstreamPayload = {
        messages: messagesForUpstream,
        stream: true, // Crucial: Request streaming response from upstream
        model: "gpt-4o-mini", // Model as observed
        temperature: 0.5,
        presence_penalty: 0,
        top_p: 1,
        key: LOVETOOME_API_KEY // The hardcoded key
      };

      // Mimic the headers observed in HTTP Canary for the upstream API call
      const upstreamHeaders = new Headers();
      upstreamHeaders.set('Content-Type', 'application/json');
      upstreamHeaders.set('Accept', 'application/json, text/event-stream'); // Accept streaming
      upstreamHeaders.set('Origin', 'https://gpt.lovetoome.com');
      upstreamHeaders.set('Referer', 'https://gpt.lovetoome.com/');
      upstreamHeaders.set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36');
      // Cookies are dynamic and session-specific, omitted for simplicity. May cause issues if required.

      // Make the POST request to the actual LOVETOOME.COM API
      const upstreamResponse = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamPayload),
      });

      // Check if the upstream API responded successfully
      if (!upstreamResponse.ok) {
        const upstreamErrorText = await upstreamResponse.text();
        console.error('Upstream API error:', upstreamResponse.status, upstreamErrorText);
        const errorResponse = new Response(JSON.stringify({
          error: `Upstream API error: ${upstreamResponse.status} - ${upstreamErrorText.slice(0, 100)}`,
          originalStatus: upstreamResponse.status
        }), { status: 502 }); // Use 502 Bad Gateway for upstream errors
        errorResponse.headers.set('Access-Control-Allow-Origin', '*');
        return errorResponse;
      }

      // --- Handle Streaming Response ---
      // This is the tricky part: we need to stream the upstream response back to the client.
      // We'll create a ReadableStream and a TransformStream to process the chunks.
      const readableStream = upstreamResponse.body; // Get the raw stream from upstream
      const transformStream = new TransformStream({
        async transform(chunk, controller) {
          // Each chunk is a Uint8Array. Convert to string.
          const text = new TextDecoder().decode(chunk);
          // Split by 'data:' prefix to get individual SSE messages
          const lines = text.split('\n').filter(line => line.startsWith('data: '));

          for (const line of lines) {
            try {
              const jsonStr = line.substring(6); // Remove 'data: ' prefix
              if (jsonStr === '[DONE]') { // End of stream marker
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                controller.terminate();
                return;
              }
              const data = JSON.parse(jsonStr);
              // Extract content from delta, if available
              const content = data.choices[0]?.delta?.content || '';
              if (content) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ content: content })}\n\n`));
              }
            } catch (e) {
              console.error('Error parsing stream chunk:', e, 'Chunk:', line);
              // Optionally, send an error chunk or just skip
            }
          }
        },
      });

      // Pipe the upstream response through our transform stream and send to client
      const proxyResponse = new Response(readableStream.pipeThrough(transformStream), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream', // Crucial: Tell client it's a stream
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
      proxyResponse.headers.set('Access-Control-Allow-Origin', '*'); // CORS for client
      return proxyResponse;

    } catch (error) {
      console.error('Worker error:', error);
      const errorResponse = new Response(JSON.stringify({ error: `Worker processing error: ${error.message}` }), { status: 500 });
      errorResponse.headers.set('Access-Control-Allow-Origin', '*');
      return errorResponse;
    }
  },
};
