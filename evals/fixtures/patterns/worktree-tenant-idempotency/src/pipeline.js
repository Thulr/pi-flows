function createPipeline({ handler }) { const layers = []; return layers.reduceRight((next, layer) => layer(next), handler); }

module.exports = { createPipeline };
