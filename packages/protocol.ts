import { z } from 'zod';
export const MAX_FRAME = 2 * 1024 * 1024;
export const capability = z.enum(['read', 'execute']);
export type Capability = z.infer<typeof capability>;
export const toolInputs = {
  bridge_status: z.object({}).strict(),
  request_blender_pairing: z.object({ team_id: z.string().min(1).max(80), capabilities: z.array(capability).min(1).max(2).default(['read']) }).strict(),
  blender_get_scene_info: z.object({}).strict(),
  blender_get_object_info: z.object({ name: z.string().min(1).max(200) }).strict(),
  blender_get_viewport_screenshot: z.object({}).strict(),
  blender_execute_code: z.object({ code: z.string().min(1).max(16000) }).strict(),
  disconnect_blender: z.object({}).strict(),
};
export type Tool = keyof typeof toolInputs;
export const toolName = z.enum(Object.keys(toolInputs) as [Tool, ...Tool[]]);
export const resultSchema = z.object({
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(MAX_FRAME) }).strict(),
    z.object({ type: z.literal('image'), data: z.string().max(MAX_FRAME), mimeType: z.enum(['image/png', 'image/jpeg']) }).strict(),
  ])).max(20),
  isError: z.boolean().optional(), structuredContent: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type Result = z.infer<typeof resultSchema>;
export const jsonResult = (value: Record<string, unknown>): Result => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export class BridgeError extends Error { constructor(public code: string) { super(code); } }
export const fail = (code: string): never => { throw new BridgeError(code); };
export const id = z.string().uuid();
export const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve'), pairing_id: id, capabilities: z.array(capability).min(1).max(2) }).strict(),
  z.object({ type: z.literal('revoke') }).strict(),
  z.object({ type: z.literal('result'), request_id: id, lease_id: id, epoch: z.number().int(), result: resultSchema }).strict(),
]);
