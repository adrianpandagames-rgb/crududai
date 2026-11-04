// Coverage palettes, lightest first: the lightest colour marks the fewest records and the darkest the most.
export const COVERAGE_PALETTES = [
  { id: 'azul', name: 'Azul cielo a marino', colors: ['#bfe6ff', '#7cc4f5', '#3a93e0', '#1a5fb4', '#0b2f6b'] },
  { id: 'rosa', name: 'Rosa a morado', colors: ['#ffc8e6', '#f28cc8', '#d14fb3', '#8e2fa6', '#4b1673'] },
  { id: 'amarillo-verde', name: 'Amarillo a verde', colors: ['#fff3a3', '#d4e86a', '#8fc94a', '#3f9a3c', '#135c2e'] },
  { id: 'calor', name: 'Amarillo a rojo', colors: ['#fff1a8', '#fdc35a', '#f78a3a', '#db4a2b', '#8c1b1b'] },
  { id: 'coral', name: 'Coral a vino', colors: ['#f08a7e', '#e8604f', '#d43d2f', '#a82820', '#6e140f'] },
  { id: 'turquesa', name: 'Turquesa a petróleo', colors: ['#c4f5ec', '#7fdcd0', '#35b5ab', '#13817f', '#074b52'] },
  { id: 'lavanda', name: 'Lavanda a índigo', colors: ['#dcd6ff', '#ada3f5', '#7b6be0', '#4c3bb5', '#241a70'] },
  { id: 'menta', name: 'Menta a bosque', colors: ['#d5f5d0', '#9be29a', '#55c060', '#258a3d', '#0c4d22'] },
  { id: 'durazno', name: 'Durazno a ciruela', colors: ['#ffd9c7', '#f7a48f', '#e06a6a', '#ab3a59', '#5e1a3f'] },
  { id: 'naranja', name: 'Naranja a café', colors: ['#ffe0b2', '#ffb74d', '#f57c00', '#b45309', '#5c2c06'] },
  { id: 'espectro', name: 'Amarillo a violeta', colors: ['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154'] },
  { id: 'gris', name: 'Gris a carbón', colors: ['#e6e8eb', '#b5bac1', '#858c96', '#555c66', '#262b32'] },
];

export const DEFAULT_PALETTE = 'azul';

export function paletteById(id) {
  return COVERAGE_PALETTES.find((palette) => palette.id === id)
    || COVERAGE_PALETTES.find((palette) => palette.id === DEFAULT_PALETTE);
}
