export function getGroupForImage(imageId, groups) {
  return groups.find((g) => g.imageIds.includes(imageId)) ?? null;
}

export function getUngroupedImages(images, groups) {
  const groupedIds = new Set(groups.flatMap((g) => g.imageIds));
  return images.filter((img) => !groupedIds.has(img.id));
}

export function getGroupImagesInOrder(images, group) {
  const idSet = new Set(group.imageIds);
  return images.filter((img) => idSet.has(img.id));
}

export function removeImageFromGroups(groups, imageId) {
  return groups
    .map((g) => ({
      ...g,
      imageIds: g.imageIds.filter((id) => id !== imageId),
      pdfBlob: null,
    }))
    .filter((g) => g.imageIds.length >= 2);
}

export function buildDownloadQueue(images, groups) {
  const queue = [];
  const downloadedGroups = new Set();

  for (const img of images) {
    const group = getGroupForImage(img.id, groups);
    if (group) {
      if (!downloadedGroups.has(group.id) && group.pdfBlob) {
        queue.push({ blob: group.pdfBlob, name: group.name });
        downloadedGroups.add(group.id);
      }
    } else if (img.pdfBlob) {
      queue.push({ blob: img.pdfBlob, name: img.customName });
    }
  }

  return queue;
}

export function isSeparateConvertComplete(images, groups) {
  if (images.length === 0) return false;

  const ungrouped = getUngroupedImages(images, groups);
  const groupsOk = groups.every((g) => g.pdfBlob);
  const ungroupedOk = ungrouped.every((img) => img.pdfBlob);

  return groupsOk && ungroupedOk;
}
