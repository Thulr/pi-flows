function chooseRegion(regions) {
  return regions.sort((a, b) => a.latencyMs - b.latencyMs)[0]?.name ?? null;
}

module.exports = { chooseRegion };
