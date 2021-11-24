import { readFileSync } from "fs";
import { join } from "path";
import { WaveFile } from 'wavefile'

// File type should be RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 8000 Hz
const EXAMPLE_FILE = join(__dirname, '../fixtures/belgium-speech.wav')

const chunkBuffer = (buf: Buffer, chunkSize: number): readonly Buffer[] => {
    const result: Buffer[] = []

    for (let i = 0; i < buf.length; i += chunkSize) {
        result.push(buf.slice(i, i + chunkSize))
    }

    return result
}

export const getWavChunks = (filePath = EXAMPLE_FILE) => {
    const wav = new WaveFile()
    wav.fromBuffer(readFileSync(filePath))
    
    return chunkBuffer((wav.data as { samples: Buffer }).samples, 160)
}
