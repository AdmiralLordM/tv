const fs = require('fs');
const { PNG } = require('pngjs');

// Read the map file
const mapData = fs.readFileSync('data/artic.raw');
const size = 256;


// Create a new PNG with RGBA (it's easier)
const png = new PNG({
    width: size,
    height: size
});

// Convert to RGBA format (pngjs uses 4 bytes per pixel internally)
for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
        const idx = (y * size + x);
        const pngIdx = idx * 4;
        const height = mapData[idx];
        
        png.data[pngIdx] = height;     // R
        png.data[pngIdx + 1] = height; // G
        png.data[pngIdx + 2] = height; // B
        png.data[pngIdx + 3] = 255;    // A
    }
}

// Write to file
png.pack().pipe(fs.createWriteStream('artic_heightmap_256.png'));

console.log('Heightmap exported to artic_heightmap.png');