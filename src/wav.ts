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

const bufferOf16BitSamplesToArray = (buf: Buffer): readonly number[] => {
    const result: number[] = []

    for (let i = 0; i < buf.length; i += 2) {
        result.push(buf.readInt16LE(i))
        // result.push(buf.readUInt16LE(i))
    }

    return result
}

export const getWavChunks = (filePath = EXAMPLE_FILE) => {
    const wav = new WaveFile()
    wav.fromBuffer(readFileSync(filePath))

    return chunkBuffer((wav.data as { samples: Buffer }).samples, 320)
}

export const writeWavChunks = (chunks: readonly Buffer[]): Buffer => {
    const wav = new WaveFile()
    wav.fromScratch(1, 8000, '16', bufferOf16BitSamplesToArray(Buffer.concat(chunks)))
    return Buffer.from(wav.toBuffer())
}

// writeFileSync('/tmp/1.wav', writeWavChunks(getWavChunks()))
