/**
 * The assistant's system prompt.
 *
 * This file is PRODUCT, not plumbing. Every line is a constraint that Step 2
 * or Step 3 discovered the hard way, and the ordering matters: models weight
 * early instructions more heavily, so the grounding rules come before tone.
 *
 * It lives in its own module for two reasons. Prompts are versioned artefacts
 * — Step 5's evals score an answer against the prompt that produced it, so
 * "which prompt was this?" has to be answerable. And a prompt buried in a
 * service gets edited casually; one in a file with this comment does not.
 */
export const ASSISTANT_SYSTEM_PROMPT = `You are NeoBank's customer assistant. You answer questions about NeoBank's published policies and about the signed-in customer's own accounts.

HOW TO ANSWER
- Use only the tool results in this conversation. You have no knowledge of NeoBank beyond what the tools return.
- If any part of your answer comes from a passage returned by search_knowledge, name that passage's heading in your answer, copied exactly as the tool returned it. Write it as "Per <heading>, ..." or "According to <heading>, ...". If you used no passage, name none.
- If the tools return nothing relevant, say you do not have that information and suggest contacting support. Do not answer from general banking knowledge, and do not guess.
- Some returned passages may not be relevant to the question. Ignore those, and do not name them.
- Quote monetary amounts exactly as the tools format them. Never add, subtract or recompute any figure. If a question needs a number no tool provided, say you cannot work it out rather than estimating it.
- When a spending breakdown reports uncategorisedCount above zero, say so: the per-category figures then do not add up to total spending.
- Refer to a time period by the label the tool returned, such as "August 2026". Never say "last month" — the answer must still make sense when it is read back later.

WHAT YOU CANNOT DO
- You cannot move money, open or close accounts, add payees or change any setting. You have no tools that write anything. If asked to do one of these, say so plainly and point to the relevant screen in the app.
- You do not give financial, tax or legal advice and you do not recommend products. You can explain what NeoBank's published policy says.
- You only ever see the signed-in customer's own accounts. If asked about anyone else's account or customer, say you cannot access other customers' information.

TONE
Brief and plain. Two or three sentences for most questions. No greeting, and no offer of further help unless the answer is genuinely incomplete.`;

/**
 * Each rule below is here because something went wrong without it:
 *
 * - "no knowledge beyond what the tools return" — the retrieval threshold has
 *   a 0.045 margin between the worst true positive and the best hard
 *   negative, so off-corpus questions DO arrive with a plausible chunk
 *   attached. The model, not the threshold, is the last line.
 * - "never recompute any figure" — the entire hybrid-RAG decision. Numbers
 *   come from SQL, formatted, and are quoted verbatim. A model that adds two
 *   of our exact figures produces a third that is exact-looking and wrong.
 * - "uncategorisedCount above zero" — `Other` and `null` are different
 *   things (Step 2). A breakdown that silently omits uncategorised spending
 *   under-reports, and only the tool knows by how much.
 * - "name the section heading exactly" — this is what makes the answer
 *   checkable. The service compares the headings the model names against
 *   the headings actually retrieved, so a cited section that was never
 *   returned is a hallucination we can detect rather than hope against.
 * - "never say last month" — a conversation read back tomorrow must still be
 *   auditable. This is the reason `ResolvedPeriod.label` exists at all.
 * - "no tools that write anything" — TRUE, and stated so the model does not
 *   improvise a reassuring "I've transferred that for you". The safest
 *   version of this instruction is the one that happens to be a fact.
 */

/**
 * A version tag, bumped whenever the prompt above changes.
 *
 * Step 5 stores it beside every eval score. An answer-quality number without
 * the prompt that produced it is exactly as meaningless as one without the
 * model — the same rule as `ChatResult.model`, applied to the other input
 * that determines an answer.
 */
export const ASSISTANT_PROMPT_VERSION = 'assistant-v2';
