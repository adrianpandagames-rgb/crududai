const clean = (value) => String(value || '').trim();

export function formatGeocodingLocation(result) {
  const details = result.addressDetails || {};
  const parts = [];
  const street = clean(details.street) || clean(result.street);
  if (street) parts.push(street);
  if (street && clean(result.betweenStreet1) && clean(result.betweenStreet2)) {
    parts.push(`entre ${clean(result.betweenStreet1)} y ${clean(result.betweenStreet2)}`);
  }
  if (clean(details.neighborhood)) parts.push(clean(details.neighborhood));
  if (clean(details.postalCode)) parts.push(`C.P. ${clean(details.postalCode)}`);
  return {
    ...result,
    address: parts.join(', ') || result.address || '',
    place: [details.city, details.state].map(clean).filter(Boolean).join(', ') || result.place || '',
  };
}

// Only recover an old Google address when its comma-separated structure is unambiguous.
export function recoverLegacyAddressDetails(address) {
  const parts = clean(address).split(',').map(clean);
  if (!/^(méxico|mexico)$/i.test(parts.at(-1))) return null;
  const postalIndex = parts.findIndex((part) => /^\d{5}\s+\S/.test(part));
  if (postalIndex < 1 || postalIndex > 2 || postalIndex !== parts.length - 3) return null;
  if (!parts[0] || /^[A-Z0-9]{4,}\+[A-Z0-9]+\b/i.test(parts[0])) return null;
  const [, postalCode, city] = parts[postalIndex].match(/^(\d{5})\s+(.+)$/);
  const stateAliases = { 'Son.': 'Sonora', 'B.C.': 'Baja California', 'B.C.S.': 'Baja California Sur', 'Sin.': 'Sinaloa', 'Chih.': 'Chihuahua' };
  const state = stateAliases[parts[postalIndex + 1]] || parts[postalIndex + 1];
  return { street: parts[0].replace(/\s+\d+[A-Za-z]?(?:\s*[-/]\s*\d+[A-Za-z]?)?$/, ''),
    neighborhood: postalIndex === 2 ? parts[1] : '', postalCode, city, state,
    originalAddress: address };
}
