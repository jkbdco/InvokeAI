import { createSelector } from '@reduxjs/toolkit';
import { selectCanvasV2Slice } from 'features/controlLayers/store/canvasV2Slice';
import { getOptimalDimension } from 'features/parameters/util/optimalDimension';

export const selectEntityCount = createSelector(selectCanvasV2Slice, (canvasV2) => {
  return (
    canvasV2.regions.entities.length +
    canvasV2.ipAdapters.entities.length +
    canvasV2.rasterLayers.entities.length +
    canvasV2.controlLayers.entities.length +
    canvasV2.inpaintMasks.entities.length
  );
});

export const selectOptimalDimension = createSelector(selectCanvasV2Slice, (canvasV2) => {
  return getOptimalDimension(canvasV2.params.model);
});