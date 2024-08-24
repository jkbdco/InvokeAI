import { logger } from 'app/logging/logger';
import type { RootState } from 'app/store/store';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import { fetchModelConfigWithTypeGuard } from 'features/metadata/util/modelFetchingHelpers';
import { addControlNets, addT2IAdapters } from 'features/nodes/util/graph/generation/addControlAdapters';
import { addImageToImage } from 'features/nodes/util/graph/generation/addImageToImage';
import { addInpaint } from 'features/nodes/util/graph/generation/addInpaint';
// import { addHRF } from 'features/nodes/util/graph/generation/addHRF';
import { addIPAdapters } from 'features/nodes/util/graph/generation/addIPAdapters';
import { addLoRAs } from 'features/nodes/util/graph/generation/addLoRAs';
import { addNSFWChecker } from 'features/nodes/util/graph/generation/addNSFWChecker';
import { addOutpaint } from 'features/nodes/util/graph/generation/addOutpaint';
import { addSeamless } from 'features/nodes/util/graph/generation/addSeamless';
import { addTextToImage } from 'features/nodes/util/graph/generation/addTextToImage';
import { addWatermarker } from 'features/nodes/util/graph/generation/addWatermarker';
import { Graph } from 'features/nodes/util/graph/generation/Graph';
import { getBoardField, getPresetModifiedPrompts, getSizes } from 'features/nodes/util/graph/graphBuilderUtils';
import type { Invocation } from 'services/api/types';
import { isNonRefinerMainModelConfig } from 'services/api/types';
import { assert } from 'tsafe';

import { addRegions } from './addRegions';

const log = logger('system');

export const buildSD1Graph = async (
  state: RootState,
  manager: CanvasManager
): Promise<{ g: Graph; noise: Invocation<'noise'>; posCond: Invocation<'compel'> }> => {
  const generationMode = manager.compositor.getGenerationMode();
  log.debug({ generationMode }, 'Building SD1/SD2 graph');

  const { bbox, params, session, settings } = state.canvasV2;

  const {
    model,
    cfgScale: cfg_scale,
    cfgRescaleMultiplier: cfg_rescale_multiplier,
    scheduler,
    steps,
    clipSkip: skipped_layers,
    shouldUseCpuNoise,
    vaePrecision,
    seed,
    vae,
  } = params;

  assert(model, 'No model found in state');

  const { positivePrompt, negativePrompt } = getPresetModifiedPrompts(state);

  const { originalSize, scaledSize } = getSizes(bbox);

  const g = new Graph(getPrefixedId('sd1_graph'));
  const modelLoader = g.addNode({
    type: 'main_model_loader',
    id: getPrefixedId('sd1_model_loader'),
    model,
  });
  const clipSkip = g.addNode({
    type: 'clip_skip',
    id: getPrefixedId('clip_skip'),
    skipped_layers,
  });
  const posCond = g.addNode({
    type: 'compel',
    id: getPrefixedId('pos_cond'),
    prompt: positivePrompt,
  });
  const posCondCollect = g.addNode({
    type: 'collect',
    id: getPrefixedId('pos_cond_collect'),
  });
  const negCond = g.addNode({
    type: 'compel',
    id: getPrefixedId('neg_cond'),
    prompt: negativePrompt,
  });
  const negCondCollect = g.addNode({
    type: 'collect',
    id: getPrefixedId('neg_cond_collect'),
  });
  const noise = g.addNode({
    type: 'noise',
    id: getPrefixedId('noise'),
    seed,
    width: scaledSize.width,
    height: scaledSize.height,
    use_cpu: shouldUseCpuNoise,
  });
  const denoise = g.addNode({
    type: 'denoise_latents',
    id: getPrefixedId('denoise_latents'),
    cfg_scale,
    cfg_rescale_multiplier,
    scheduler,
    steps,
    denoising_start: 0,
    denoising_end: 1,
  });
  const l2i = g.addNode({
    type: 'l2i',
    id: getPrefixedId('l2i'),
    fp32: vaePrecision === 'fp32',
  });
  const vaeLoader =
    vae?.base === model.base
      ? g.addNode({
          type: 'vae_loader',
          id: getPrefixedId('vae'),
          vae_model: vae,
        })
      : null;

  let canvasOutput: Invocation<'l2i' | 'img_nsfw' | 'img_watermark' | 'img_resize' | 'canvas_v2_mask_and_crop'> = l2i;

  g.addEdge(modelLoader, 'unet', denoise, 'unet');
  g.addEdge(modelLoader, 'clip', clipSkip, 'clip');
  g.addEdge(clipSkip, 'clip', posCond, 'clip');
  g.addEdge(clipSkip, 'clip', negCond, 'clip');
  g.addEdge(posCond, 'conditioning', posCondCollect, 'item');
  g.addEdge(negCond, 'conditioning', negCondCollect, 'item');
  g.addEdge(posCondCollect, 'collection', denoise, 'positive_conditioning');
  g.addEdge(negCondCollect, 'collection', denoise, 'negative_conditioning');
  g.addEdge(noise, 'noise', denoise, 'noise');
  g.addEdge(denoise, 'latents', l2i, 'latents');

  const modelConfig = await fetchModelConfigWithTypeGuard(model.key, isNonRefinerMainModelConfig);
  assert(modelConfig.base === 'sd-1' || modelConfig.base === 'sd-2');

  g.upsertMetadata({
    generation_mode: 'txt2img',
    cfg_scale,
    cfg_rescale_multiplier,
    width: scaledSize.width,
    height: scaledSize.height,
    positive_prompt: positivePrompt,
    negative_prompt: negativePrompt,
    model: Graph.getModelMetadataField(modelConfig),
    seed,
    steps,
    rand_device: shouldUseCpuNoise ? 'cpu' : 'cuda',
    scheduler,
    clip_skip: skipped_layers,
    vae: vae ?? undefined,
  });

  const seamless = addSeamless(state, g, denoise, modelLoader, vaeLoader);

  addLoRAs(state, g, denoise, modelLoader, seamless, clipSkip, posCond, negCond);

  // We might get the VAE from the main model, custom VAE, or seamless node.
  const vaeSource: Invocation<
    'main_model_loader' | 'sdxl_model_loader' | 'sdxl_model_loader' | 'seamless' | 'vae_loader'
  > = seamless ?? vaeLoader ?? modelLoader;
  g.addEdge(vaeSource, 'vae', l2i, 'vae');

  if (generationMode === 'txt2img') {
    canvasOutput = addTextToImage(g, l2i, originalSize, scaledSize);
  } else if (generationMode === 'img2img') {
    canvasOutput = await addImageToImage(
      g,
      manager,
      l2i,
      denoise,
      vaeSource,
      originalSize,
      scaledSize,
      bbox,
      1 - params.img2imgStrength
    );
  } else if (generationMode === 'inpaint') {
    const { compositing } = state.canvasV2;
    canvasOutput = await addInpaint(
      state,
      g,
      manager,
      l2i,
      denoise,
      vaeSource,
      modelLoader,
      originalSize,
      scaledSize,
      bbox,
      compositing,
      1 - params.img2imgStrength,
      vaePrecision
    );
  } else if (generationMode === 'outpaint') {
    const { compositing } = state.canvasV2;
    canvasOutput = await addOutpaint(
      state,
      g,
      manager,
      l2i,
      denoise,
      vaeSource,
      modelLoader,
      originalSize,
      scaledSize,
      bbox,
      compositing,
      1 - params.img2imgStrength,
      vaePrecision
    );
  }

  const controlNetCollector = g.addNode({
    type: 'collect',
    id: getPrefixedId('control_net_collector'),
  });
  const controlNetResult = await addControlNets(
    manager,
    state.canvasV2.controlLayers.entities,
    g,
    state.canvasV2.bbox.rect,
    controlNetCollector,
    modelConfig.base
  );
  if (controlNetResult.addedControlNets > 0) {
    g.addEdge(controlNetCollector, 'collection', denoise, 'control');
  } else {
    g.deleteNode(controlNetCollector.id);
  }

  const t2iAdapterCollector = g.addNode({
    type: 'collect',
    id: getPrefixedId('t2i_adapter_collector'),
  });
  const t2iAdapterResult = await addT2IAdapters(
    manager,
    state.canvasV2.controlLayers.entities,
    g,
    state.canvasV2.bbox.rect,
    controlNetCollector,
    modelConfig.base
  );
  if (t2iAdapterResult.addedT2IAdapters > 0) {
    g.addEdge(t2iAdapterCollector, 'collection', denoise, 't2i_adapter');
  } else {
    g.deleteNode(t2iAdapterCollector.id);
  }

  const ipAdapterCollector = g.addNode({
    type: 'collect',
    id: getPrefixedId('ip_adapter_collector'),
  });
  const ipAdapterResult = addIPAdapters(state.canvasV2.ipAdapters.entities, g, ipAdapterCollector, modelConfig.base);

  const regionsResult = await addRegions(
    manager,
    state.canvasV2.regions.entities,
    g,
    state.canvasV2.bbox.rect,
    modelConfig.base,
    denoise,
    posCond,
    negCond,
    posCondCollect,
    negCondCollect,
    ipAdapterCollector
  );

  const totalIPAdaptersAdded =
    ipAdapterResult.addedIPAdapters + regionsResult.reduce((acc, r) => acc + r.addedIPAdapters, 0);
  if (totalIPAdaptersAdded > 0) {
    g.addEdge(ipAdapterCollector, 'collection', denoise, 'ip_adapter');
  } else {
    g.deleteNode(ipAdapterCollector.id);
  }

  if (state.system.shouldUseNSFWChecker) {
    canvasOutput = addNSFWChecker(g, canvasOutput);
  }

  if (state.system.shouldUseWatermarker) {
    canvasOutput = addWatermarker(g, canvasOutput);
  }

  const shouldSaveToGallery = session.mode === 'generate' || settings.autoSave;

  g.updateNode(canvasOutput, {
    id: getPrefixedId('canvas_output'),
    is_intermediate: !shouldSaveToGallery,
    use_cache: false,
    board: getBoardField(state),
  });

  g.setMetadataReceivingNode(canvasOutput);
  return { g, noise, posCond };
};