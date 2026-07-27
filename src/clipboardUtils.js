export const normalizeClipboardValue = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replace(/\r\n?/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ')
    .trim();
};

export const buildClipboardText = (values) => {
  const normalizedValues = values.map((value) => normalizeClipboardValue(value));
  return `${normalizedValues.join('\t')}\r\n`;
};
