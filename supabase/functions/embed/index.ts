/**
 * Auto-Embedding Edge Function
 *
 * Called via database webhook on INSERT to messages/memory tables.
 * Generates an OpenAI embedding and stores it on the row.
 *
 * Secrets required:
 *   OPENAI_API_KEY — stored in Supabase Edge Function secrets
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const { record, table } = await req.json();

    if (!record?.content || !record?.id) {
      return new Response("Missing record data", { status: 400 });
    }

    // Skip if embedding already exists
    if (record.embedding) {
      return new Response("Already embedded", { status: 200 });
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response("OPENAI_API_KEY not configured", { status: 500 });
    }

    // Generate embedding via OpenAI
    const embeddingResponse = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: record.content,
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      return new Response(`OpenAI error: ${err}`, { status: 500 });
    }

    const { data } = await embeddingResponse.json();
    const embedding = data[0].embedding;

    // Update the row with the embedding
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { error } = await supabase
      .from(table)
      .update({ embedding })
      .eq("id", record.id);

    if (error) {
      return new Response(`Supabase update error: ${error.message}`, {
        status: 500,
      });
    }

    return new Response("ok");
  } catch (error) {
    return new Response(String(error), { status: 500 });
  }
});
