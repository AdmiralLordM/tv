#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Check if file path is provided
if (process.argv.length < 3) {
    console.error('Usage: node extract.js <archive_file>');
    process.exit(1);
}

const archivePath = process.argv[2];

// Check if file exists
if (!fs.existsSync(archivePath)) {
    console.error(`Error: File "${archivePath}" does not exist.`);
    process.exit(1);
}

try {
    // Read the entire archive file
    const archiveData = fs.readFileSync(archivePath);
    let offset = 0;

    // Read number of files (first 4 bytes as uint32, little-endian)
    const fileCount = archiveData.readUInt32LE(offset);
    offset += 4;

    console.log(`Found ${fileCount} files in archive`);

    // Skip header (50 bytes)
    offset += 80;

    // Array to store file entries
    const files = [];

    // Read file entries
    for (let i = 0; i < fileCount; i++) {
        // Read filename/path (32 bytes, null-terminated)
        const pathBytes = archiveData.slice(offset, offset + 32);
        const nullIndex = pathBytes.indexOf(0);
        const filePath = pathBytes.slice(0, nullIndex > -1 ? nullIndex : 32).toString();
        offset += 32;

        // Read file size (4 bytes, uint32, little-endian)
        const fileSize = archiveData.readUInt32LE(offset);
        offset += 4;

        // Read file position (4 bytes, uint32, little-endian)
        const filePosition = archiveData.readUInt32LE(offset);
        offset += 4;

        // Trim the path and store
        files.push({
            path: filePath.trim(),
            size: fileSize,
            position: filePosition
        });
    }

    //console.log(files);
    //process.exit(0);
    // Extract files
    console.log('\nExtracting files...\n');
    let extractedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
        // Skip if path is empty or just whitespace
        const trimmedPath = file.path.trim();
        if (!trimmedPath || trimmedPath.length === 0) {
            skippedCount++;
            continue;
        }

        // Convert path to lowercase and normalize separators
        const normalizedPath = trimmedPath.toLowerCase().replace(/\\/g, '/').trim();
        
        // Skip if normalized path is empty or just a slash
        if (!normalizedPath || normalizedPath === '/' || normalizedPath === '\\') {
            skippedCount++;
            continue;
        }

        // Resolve to absolute path (relative to current working directory)
        const fullPath = path.resolve(normalizedPath);
        
        // Check if the resolved path is a directory (shouldn't happen, but safety check)
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
            console.log(`Skipping directory path: ${fullPath}`);
            skippedCount++;
            continue;
        }

        const dirPath = path.dirname(fullPath);

        // Create directory if it doesn't exist
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true, mode: 0o777 });
            console.log(`Created directory: ${dirPath}`);
        }

        // Extract file content
        try {
            const fileContent = archiveData.slice(file.position, file.position + file.size);
            fs.writeFileSync(fullPath, fileContent, { mode: 0o666 });
            console.log(`Extracted: ${fullPath} (${file.size} bytes)`);
            extractedCount++;
        } catch (err) {
            console.error(`Failed to extract: ${fullPath} - ${err.message}`);
            skippedCount++;
        }
    }

    console.log(`\nSuccessfully extracted ${extractedCount} files.`);
    if (skippedCount > 0) {
        console.log(`Skipped ${skippedCount} invalid entries.`);
    }

} catch (error) {
    console.error(`Error processing archive: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
}

