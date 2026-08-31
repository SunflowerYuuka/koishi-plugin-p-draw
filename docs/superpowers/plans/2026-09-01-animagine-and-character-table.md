# Animagine Model And Character Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove continuous/i2i functionality, add Animagine XL as a selectable SDXL T2I model, and store fixed characters as one database row per character.

**Architecture:** Keep the existing Anima workflow unchanged for Anima models. Add a separate SDXL workflow selected by the active model name, while preserving the existing model parameter override and LLM tag optimization paths. Move fixed-character persistence from the JSON array in `p_draw_config` to a dedicated `p_draw_fixed_characters` table, with one-time migration from legacy configuration data.

**Tech Stack:** Node.js, Koishi, ComfyUI API, SQLite/Koishi database service, Node built-in test runner.

**Spec:** Approved in chat on 2026-09-01: remove continuous/i2i; add Animagine SDXL T2I model routing; reuse Danbooru-style LLM optimization; add `p_draw_fixed_characters` with `id`, `name`, and `tags`.

## Global Constraints

- Do not commit, tag, or push unless explicitly requested.
- Preserve ordinary batch generation (`x3`, `3张`) because it is not continuous generation.
- Do not add IP-Adapter, ControlNet, FaceID, inpainting, or other i2i behavior to the plugin.
- Keep Anima model loading through `UNETLoader` + `CLIPLoader` + configured VAE.
- Use a dedicated SDXL checkpoint workflow for Animagine; never mix Anima and SDXL loaders.
- Animagine uses the existing Danbooru/tag LLM optimization template.
- Legacy `fixed_characters` data must be migrated without data loss; the dedicated table becomes the runtime source of truth.

---

### Task 1: Remove Continuous And i2i Functionality

**Files:**
- Modify: `index.js`
- Modify: `lib/i18n.js`
- Modify: `readme.md`
- Modify: `test/apply.test.js`
- Modify: `test/lib.test.js`

**Interfaces:**
- Removes the `连续` command branch, `handleGenerateSeries`, stage-specific LLM helpers, `seriesAskTimeout`, and all i2i-related public/internal interfaces.
- Keeps ordinary generation, batch generation, model switching, fixed-character commands, and existing Anima T2I behavior.

- [ ] **Step 1: Add/adjust failing tests**

Add assertions that the plugin configuration and help text do not expose continuous generation, and keep the existing assertions that `handleGenerateI2I` and `animaI2IWorkflow` are absent. Add a source-level test or exported helper assertion that no continuous command handler is registered.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```powershell
node --test test/apply.test.js test/lib.test.js
```

Expected: the new absence assertions fail while the old continuous implementation remains.

- [ ] **Step 3: Remove implementation and configuration**

Delete the continuous command parser and handler from `index.js`, including stage splitting, stage optimization, seed-sharing continuous queue logic, and `seriesAskTimeout`. Remove all i2i identifiers and dead imports/helpers. Remove continuous/i2i help text and configuration descriptions from `lib/i18n.js` and `readme.md`.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
node --test test/apply.test.js test/lib.test.js
```

Expected: PASS, with ordinary generation tests unchanged.

- [ ] **Step 5: Verify no residual identifiers**

Run:

```powershell
Get-ChildItem -Recurse -File -Include *.js,*.md | Select-String -Pattern '连续|series|i2i|I2I|img2img|inpaint|Inpaint|IPAdapter|ControlNet'
```

Expected: no plugin behavior/config/documentation matches, except explicitly retained historical test wording only if required by the existing public interface test; remove such wording where possible.

### Task 2: Add Animagine SDXL Workflow And Model Routing

**Files:**
- Modify: `lib/workflows.js`
- Modify: `index.js`
- Modify: `lib/i18n.js`
- Modify: `test/lib.test.js`
- Modify: `test/apply.test.js`
- Modify: `readme.md`

**Interfaces:**
- Add `animagineT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed)` returning a ComfyUI API prompt using `CheckpointLoaderSimple`, `CLIPTextEncode`, `EmptyLatentImage`, `KSampler`, `VAEDecode`, and `SaveImage`.
- Update `buildWorkflow` to select `animagineT2IWorkflow` when the active model resolves to `animagine-xl-3.1.safetensors`; retain custom workflow precedence and Anima routing for all other models.
- Add model-aware defaults/overrides without changing the existing `modelParams` contract.

- [ ] **Step 1: Write failing workflow tests**

Add tests that call `animagineT2IWorkflow` and assert:

```js
assert.strictEqual(workflow['1'].class_type, 'CheckpointLoaderSimple')
assert.strictEqual(workflow['1'].inputs.ckpt_name, 'animagine-xl-3.1.safetensors')
assert.strictEqual(workflow['4'].class_type, 'CLIPTextEncode')
assert.strictEqual(workflow['5'].inputs.latent_image[0], '3')
assert.strictEqual(workflow['7'].inputs.samples[0], '6')
```

Also test that `buildWorkflow` routes the Animagine model to the SDXL workflow and an Anima model to `animaT2IWorkflow`.

- [ ] **Step 2: Run focused tests to confirm failure**

Run:

```powershell
node --test test/lib.test.js
```

Expected: FAIL because the new workflow/export/routing does not exist.

- [ ] **Step 3: Implement the SDXL workflow**

Build a pure prompt object with these connections:

```text
CheckpointLoaderSimple MODEL → KSampler model
CheckpointLoaderSimple CLIP → positive/negative CLIPTextEncode
CheckpointLoaderSimple VAE → VAEDecode vae
EmptyLatentImage → KSampler latent_image
positive/negative CLIPTextEncode → KSampler positive/negative
KSampler → VAEDecode → SaveImage
```

Use the passed width, height, steps, CFG, sampler, scheduler, and seed. Use `filename_prefix: 'pdraw/animagine'`.

- [ ] **Step 4: Implement model routing**

Pass the active model name into workflow selection or derive it from the effective config. Normalize only case and `-`/`_` for comparison. Route only the exact normalized Animagine XL 3.1 model name to the SDXL workflow; keep custom workflow precedence.

- [ ] **Step 5: Add model documentation and descriptions**

Document that Animagine XL 3.1 is an SDXL Danbooru/tag model, uses the existing `promptOptimizeTemplate`, and is selected with `p-draw 模型 animagine`. Update the model list description to mention both Anima and Animagine names.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
node --test test/lib.test.js test/apply.test.js
```

Expected: PASS.

### Task 3: Add Dedicated Fixed Character Table And Migration

**Files:**
- Modify: `index.js`
- Modify: `test/apply.test.js`
- Modify: `readme.md`

**Interfaces:**
- Use Koishi database table `p_draw_fixed_characters` with fields `id`, `name`, and `tags`.
- Add a startup migration that reads legacy `p_draw_config.fixed_characters`, inserts missing character rows, and marks migration completion without duplicating rows.
- Make fixed-character commands read/write the dedicated table while retaining the legacy config field only as compatibility storage for Koishi config serialization.

- [ ] **Step 1: Write failing database tests**

Extend the mock database to record `get`, `create`, and `set` calls. Add tests asserting that plugin startup declares/uses `p_draw_fixed_characters`, migrates:

```js
['可可萝=kokkoro_(princess_connect!)', '角色B=1girl, blue eyes']
```

into two rows, and does not insert duplicates on a second startup. Add command-level tests for adding, listing, and deleting a character against the new table.

- [ ] **Step 2: Run focused tests to confirm failure**

Run:

```powershell
node --test test/apply.test.js
```

Expected: FAIL because the new table and migration do not exist.

- [ ] **Step 3: Define the table and migration**

At plugin initialization, call the Koishi database extension for `p_draw_fixed_characters` with:

```js
{
  id: 'unsigned',
  name: 'string',
  tags: 'text',
}
```

Read existing rows first. Parse legacy `name=tags` entries using the existing preset parser, insert only names not already present, and avoid modifying unrelated configuration fields.

- [ ] **Step 4: Switch runtime character access**

Replace reads of `cfg.fixedCharacters` in character parsing, prompt composition, status output, and character commands with database-backed helpers. Keep command syntax unchanged. For add/update, update the matching row; for delete, remove the matching row; for list/status, query rows ordered by `id`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --test test/apply.test.js
```

Expected: PASS, including migration idempotency and character command behavior.

- [ ] **Step 6: Document database layout**

Update `readme.md` to state that fixed characters are stored one per row in `p_draw_fixed_characters`, with legacy config migration on first startup.

### Task 4: Cleanup, Full Verification, And Documentation Review

**Files:**
- Modify: `index.js`
- Modify: `lib/workflows.js`
- Modify: `lib/i18n.js`
- Modify: `readme.md`
- Modify: `test/lib.test.js`
- Modify: `test/apply.test.js`

- [ ] **Step 1: Run all tests**

Run:

```powershell
node --test test/lib.test.js test/apply.test.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run JavaScript syntax checks**

Run:

```powershell
node --check index.js
foreach ($f in Get-ChildItem 'lib\*.js') { node --check $f.FullName; if ($LASTEXITCODE -ne 0) { exit 1 } }
```

Expected: every file passes syntax validation.

- [ ] **Step 3: Re-run residual search**

Run:

```powershell
Get-ChildItem -Recurse -File -Include *.js,*.md | Select-String -Pattern '连续|series|i2i|I2I|img2img|inpaint|Inpaint|IPAdapter|ControlNet'
```

Expected: no functional or documentation residue.

- [ ] **Step 4: Inspect the final diff**

Run:

```powershell
git diff --check
```

Confirm only intended files changed, no secrets are present, and no commit/tag/push is performed.
