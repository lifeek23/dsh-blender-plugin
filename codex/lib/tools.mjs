// A separate MCP surface: the original DSH tool registry is unchanged.
const string = { type: 'string', minLength: 1 }
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum })
const vector = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }
const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const tool = (name, description, properties, required, readOnlyHint = false) => ({
  name,
  description,
  inputSchema: schema(properties, required),
  annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: false },
})
export const TOOL_DEFINITIONS = [
  tool(
    'blender_session',
    'Inspect Gateway or attach/release a connected GUI Blender. GUI is optional; headless jobs need no session. Never steals another owner or resumes human-paused writes.',
    {
      action: { type: 'string', enum: ['status', 'list', 'doctor', 'attach', 'claim', 'release'] },
      session_id: string,
      instance_id: string,
    },
  ),
  tool(
    'blender_inspect',
    'Read scene/object information. Set blend_file for a short headless job (works on a NAS without GUI). Otherwise read the attached GUI via a read-only command; command=help lists commands.',
    {
      blend_file: string,
      command: string,
      args: { type: 'object', additionalProperties: true },
      timeout_ms: integer(1000, 60000),
    },
    [],
    true,
  ),
  tool(
    'blender_py',
    'Run Python in an already attached GUI session. No implicit GUI/headless fallback. For a NAS use blender_run(kind=headless). Save/export via bpy in your script; code and file are mutually exclusive.',
    {
      code: string,
      file: string,
      session_id: string,
      see: { type: 'boolean' },
      timeout_ms: integer(1000, 120000),
      wait_ms: integer(0, 5000),
    },
  ),
  tool(
    'blender_see',
    'Return an actual PNG image. image_path reads a local rendered PNG without launching Blender. Otherwise capture the connected GUI viewport, camera, or a custom viewpoint.',
    {
      image_path: string,
      viewpoint: { type: 'string', enum: ['viewport', 'camera', 'custom'] },
      camera: string,
      from: vector,
      look_at: vector,
      max_size: integer(120, 1600),
      width: integer(120, 1600),
      height: integer(120, 1600),
      ortho: { type: 'boolean' },
      ortho_scale: { type: 'number', exclusiveMinimum: 0 },
    },
    [],
    true,
  ),
  tool(
    'blender_run',
    'Submit an asynchronous fresh Blender background job, then status/wait/collect/cancel by id. Headless script can model, render, save .blend and export. file explicitly opens an existing .blend before script. Outputs persist in outdir; process state does not persist. A wait timeout keeps the job running. Python exceptions fail the job.',
    {
      action: { type: 'string', enum: ['submit', 'status', 'wait', 'collect', 'cancel', 'list'] },
      kind: { type: 'string', enum: ['headless'] },
      id: string,
      script: string,
      script_file: string,
      file: string,
      outdir: string,
      timeout_ms: integer(1000, 3600000),
      wait_ms: integer(1000, 60000),
      tail: integer(1, 262144),
      priority: integer(-100, 100),
    },
  ),
]
