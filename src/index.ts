import { filter, firstValueFrom, Observable, Subject } from 'rxjs'
import SerialPort from 'serialport'
import { getWavChunks, writeWavChunks } from './wav'
import { writeFile } from 'node:fs/promises'

const device = '/dev/ttyUSB0'

// See Table 29 in https://www.dvsinc.com/manuals/AMBE-3000R_manual.pdf
const PACKET_TYPE_TO_ID = {
    'control': 0x0,
    'speech': 0x02,
    'channel': 0x01
} as const

class SpeechDataPacket {
    #data: Buffer

    private constructor(data: Buffer) {
        this.#data = data
    }

    static create(data: Buffer) {
        return new SpeechDataPacket(data)
    }

    get data(): Buffer {
        return this.#data
    }
}

class ChannelDataPacket {
    #data: Buffer
    #numBits: number

    private constructor(data: Buffer, numBits: number) {
        this.#data = data
        this.#numBits = numBits
    }

    static create(data: Buffer, numBits: number) {
        return new ChannelDataPacket(data, numBits)
    }

    get data(): Buffer {
        return this.#data
    }

    get numBits(): number {
        return this.#numBits
    }
}

const serialport = new SerialPort(device, {
    baudRate: 460800
}, (err) => {
    if (err == null) {
        console.log(`Successfully connected to ${device}`)
    } else {
        console.log(`Error connecting to ${device} - err ${err}`)
    }
})

class DVstick30 {
    #sp: SerialPort
    #buffer = Buffer.alloc(0)
    #packets = new Subject<DecodedPacket>()

    constructor(sp: SerialPort) {
        // Some debugging log statements
        serialport.on('open', () => console.log('Serial port: open'))
        serialport.on('error', (err) => console.error('Serial port: error', err))
        serialport.on('close', (err) => console.log('Serial port: close', err))
        serialport.on('data', (data) => {
            this.addData(data)
            this.tryDecodePacketsFromBuffer()
        })


        this.#sp = sp
    }

    get packets (): Observable<DecodedPacket> {
        return this.#packets
    }

    /** Handles adding the magic number and packet length to prepare a packet for sending */
    private static encodePacket(packetType: 'channel' | 'speech' | 'control', payload: Buffer): Buffer {
        const lengthBuffer = Buffer.alloc(2, 0)
        lengthBuffer.writeUInt16BE(payload.length)
        const payloadTypeBuffer = Buffer.alloc(1, 0)
        payloadTypeBuffer.writeUInt8(PACKET_TYPE_TO_ID[packetType])
    
        const result = Buffer.concat([
            Buffer.from('61', 'hex'), // magic number   
            lengthBuffer,
            payloadTypeBuffer,
            payload
        ])

        return result
    }

    async setRateT (rate: number) {
        this.#sp.write(DVstick30.encodePacket('control', Buffer.from('\x09' + String.fromCharCode(rate))))

        await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'control-response' && packet.controlPacketType === 'PKT_RATET')))
    }

    async setRateP() {
        throw new Error('Not implemented')
    }

    async init(): Promise<boolean> {
        const encoderAndDecoderInitialized = '\x03'
        this.#sp.write(DVstick30.encodePacket('control', Buffer.from('\x0B' + encoderAndDecoderInitialized)))
        const packet = await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'control-response' && packet.controlPacketType === 'PKT_INIT')))

        return (packet as ControlResponseInit).successfulInit
    }

    async getVersion () {
        const versionControl = '\x31'
        this.#sp.write(DVstick30.encodePacket('control', Buffer.from(versionControl)))

        const reply = await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'control-response' && packet.controlPacketType === 'PKT_VERSTRING')))

        return (reply as ControlResponseVersion).versionString
    }

    async reset() {
        const reset = '\x33'
        this.#sp.write(DVstick30.encodePacket('control', Buffer.from(reset)))

        await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'control-response' && packet.controlPacketType === 'PKT_READY')))
    }

    async getProductId(): Promise<string> {
        const productId = '\x30'
        this.#sp.write(DVstick30.encodePacket('control', Buffer.from(productId)))

        const reply = await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'control-response' && packet.controlPacketType === 'PKT_PRODID')))

        return (reply as ControlResponseProductId).productId
    }

    async encodeSpeechPacket(speechPacket: SpeechDataPacket): Promise<ChannelDataPacket> {
        const PKT_CHANNEL0 = Buffer.from('\x40')
        const numSpeechSamples = Math.ceil(speechPacket.data.length / 2)
        const SPEECHD = Buffer.from([0, numSpeechSamples])
        this.#sp.write(DVstick30.encodePacket('speech', Buffer.concat([ PKT_CHANNEL0, SPEECHD, speechPacket.data ])))

        const reply = await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'speech-data-packet-response')))

        return (reply as SpeechDataPacketResponse).encodedSpeech
    }

    async decodeChannelPacket(channelPacket: ChannelDataPacket): Promise<SpeechDataPacket> {
        // const PKT_CHANNEL0 = Buffer.from('\x40')
        const CHAND = Buffer.from([1, channelPacket.data.length * 8])
        this.#sp.write(DVstick30.encodePacket('channel', Buffer.concat([ /* PKT_CHANNEL0, */ CHAND, channelPacket.data ])))

        const reply = await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'channel-data-packet-response')))

        return (reply as ChannelDataPacketResponse).decodedSpeech
    }

    private addData(buf: Buffer) {
        this.#buffer = Buffer.concat([ this.#buffer, buf ])
    }

    private tryDecodePacketsFromBuffer (): void {
        // Packet structure:
        // 0      - Magic number 97
        // 1,2    - Packet length, excluding magic number, packet length, and payload type
        // 3      - Payload type
        // 4-...  - Payload
    
        const startByte = this.#buffer.indexOf('\x61')
    
        // No start byte (yet)
        if (startByte === -1) {
            return
        }
    
        this.#buffer = this.#buffer.slice(startByte)
    
        // Packet too short
        if (this.#buffer.length < 5) {
            return
        }
    
        // const length = (buf.readUInt8(1) << 8) + buf.readUInt8(2)
        const length = this.#buffer.readUInt16BE(1)
        const packetLength = length + 4
    
        // Packet not complete yet
        if (this.#buffer.length < packetLength) {
            return
        }
    
        const packetType = this.#buffer.readUInt8(3)
        const payload = this.#buffer.slice(4, packetLength)
        
        const decoded = this.decodePacket({ type: packetType, payload })
    
        if (decoded == null) {
            console.log(`Could not decode packet with type ${packetType}. Payload: ${payload}`)
        } else {
            this.#packets.next(decoded)
        }

        this.#buffer = this.#buffer.slice(packetLength)
        this.tryDecodePacketsFromBuffer()
    }

    private decodePacket(packet: { type: number, payload: Buffer }): null | DecodedPacket {
        switch (packet.type) {
            case PACKET_TYPE_TO_ID.channel:
                if (packet.payload[0] !== 0x01) {
                    throw new Error('Expected CHAND field identifier at payload position 0')
                }

                const numBits = packet.payload[1]

                return {
                        type: 'speech-data-packet-response',
                        encodedSpeech: ChannelDataPacket.create(packet.payload.slice(2), numBits)
                    }

            case PACKET_TYPE_TO_ID.speech:
                if (packet.payload[0] !== 0x00) {
                    throw new Error('Expected SPEECHD field identifier at payload position 0')
                }

                if (packet.payload[1] * 2 !== packet.payload.length - 2) {
                    throw new Error(`SPEECHD (number of samples) (=${packet.payload[1]} samples) did not match payload length (=${packet.payload.length - 2} bytes)`)
                }

                return {
                    type: 'channel-data-packet-response',
                    decodedSpeech: SpeechDataPacket.create(packet.payload.slice(2))
                }

            case PACKET_TYPE_TO_ID.control:
                const fieldIdentifier = packet.payload[0]
                const payload = packet.payload.slice(1)

                switch (fieldIdentifier) {
                    case 0x30:
                        return {
                            type: 'control-response',
                            controlPacketType: 'PKT_PRODID',
                            productId: payload.toString('ascii').slice(0, -1)
                        }
                    case 0x31:
                        return {
                            type: 'control-response',
                            controlPacketType: 'PKT_VERSTRING',
                            versionString: payload.toString('ascii').slice(0, -1)
                        }
                    case 0x09:
                        return {
                            type: 'control-response',
                            controlPacketType: 'PKT_RATET'
                        }
                    case 0x0b:
                        return {
                            type: 'control-response',
                            controlPacketType: 'PKT_INIT',
                            successfulInit: payload.readUInt8() === 0
                        }
                    case 0x39:
                        return {
                            type: 'control-response',
                            controlPacketType: 'PKT_READY'
                        }
                }

                return {
                    type: 'control-response',
                    controlPacketType: 'unknown',
                    fieldIdentifier,
                    payload
                }
            default: return null
        }
    }
}

const stick = new DVstick30(serialport)

type DecodedPacket = ControlResponse | SpeechDataPacketResponse | ChannelDataPacketResponse

type SpeechDataPacketResponse = {
    type: 'speech-data-packet-response'
    encodedSpeech: ChannelDataPacket
}

type ChannelDataPacketResponse = {
    type: 'channel-data-packet-response'
    decodedSpeech: SpeechDataPacket
}

type ControlResponseProductId = {
    type: 'control-response'
    controlPacketType: 'PKT_PRODID'
    productId: string
}

type ControlResponseVersion = {
    type: 'control-response'
    controlPacketType: 'PKT_VERSTRING'
    versionString: string
}

type ControlResponseRateT = {
    type: 'control-response'
    controlPacketType: 'PKT_RATET'
}

type ControlResponseInit = {
    type: 'control-response'
    controlPacketType: 'PKT_INIT'
    successfulInit: boolean
}

type ControlResponseReady = {
    type: 'control-response',
    controlPacketType: 'PKT_READY'
}

type ControlResponse = ControlResponseVersion | ControlResponseRateT | ControlResponseProductId | ControlResponseInit | ControlResponseReady | {
    type: 'control-response',
    controlPacketType: 'unknown',
    fieldIdentifier: number,
    payload: Buffer
}

// stick.packets.subscribe((packet) => console.log(packet))

const chunks = getWavChunks().slice(0, 500).map(chunk => SpeechDataPacket.create(chunk))
const exampleSpeechDataPacket = SpeechDataPacket.create(Buffer.from('0000000100020003000400050006000700080009000A000B000C000D000E000F0010001100120013001400150001601700180019001A001B001C001D001E001F0020002100220023002400250026002700280029002A002B002C002D002E002F0030003100320033003400350036003700380039003A003B003C003D003E003F0040004100420043004400450046004700480049004A004B004C004D004E004F0050005100520053005400550056005700580059005A005B005C005D005E005F0060006100620063006400650066006700680069006A006B006C006D006E006F0070007100720073007400750076007700780079007A007B007C007D007E007F0080008100820083008400850086008700880089008A008B008C008D008E008F0090009100920093009400950096009700980099009A009B009C009D009E009F', 'hex'))
// const exampleChannelDataPacket = ChannelDataPacket.create(Buffer.from('00112233445566778899', 'hex'), 80)

; (async () => {
    try {
        await stick.reset()
        const version = await stick.getVersion()
        console.log(`version is ${version}`)
    
        const productId = await stick.getProductId()
        console.log(`product id is ${productId}`)
    
        console.log(`set rate result: ${await stick.setRateT(33)}`)

        console.log(`init result: ${await stick.init()}`)

        const encodedSpeech = await stick.encodeSpeechPacket(exampleSpeechDataPacket)
        console.log('encoded speech result', encodedSpeech.data)
        console.log('encoded speech length', encodedSpeech.data.length)

        let encodedChunks: ChannelDataPacket[] = []
        for (const chunk of chunks) {
            encodedChunks.push(await stick.encodeSpeechPacket(chunk))
        }

        let decodedChunks: SpeechDataPacket[] = []
        for (const encoded of encodedChunks) {
            decodedChunks.push(await stick.decodeChannelPacket(encoded))
        }

        console.log('chunk 100')
        console.log(chunks[100].data)
        console.log(decodedChunks[100].data)

        // const decodedSpeech = await stick.decodeChannelPacket(exampleChannelDataPacket)

        // console.log(decodedSpeech.data)
        // console.log(decodedSpeech.data.length)

        await writeFile('output.wav', writeWavChunks(decodedChunks.map(p => p.data)))
        await writeFile('test.wav', writeWavChunks(chunks.map(p => p.data)))
        
        // await setTimeout(1000)
    } catch (err) {
        console.error(err)
    } finally {
        serialport.close()
    }
})()
