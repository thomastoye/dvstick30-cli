import { filter, firstValueFrom, Observable, Subject } from 'rxjs'
import SerialPort from 'serialport'

const device = '/dev/ttyUSB0'

// See Table 29 in https://www.dvsinc.com/manuals/AMBE-3000R_manual.pdf
const PACKET_TYPE_TO_ID = {
    'control': 0x0,
    'speech': 0x02,
    'channel': 0x01
} as const

class SpeechDataPacket {
    get data(): Buffer {
        throw new Error('TODO')
    }
}

class ChannelDataPacket {

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

const DVSTICK_PACKET_TYPE = {
    CONTROL: 0,
    AMBE: 1,
    PCM: 2
} as const

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

    private static encodePacket(packetType: 'channel' | 'speech' | 'control', payload: Buffer): Buffer {
        const lengthBuffer = Buffer.alloc(2, 0)
        lengthBuffer.writeUInt16BE(payload.length)
        const payloadTypeBuffer = Buffer.alloc(1, 0)
        payloadTypeBuffer.writeUInt8(PACKET_TYPE_TO_ID[packetType])
    
        return Buffer.concat([
            Buffer.from('61', 'hex'), // magic number   
            lengthBuffer,
            payloadTypeBuffer,
            payload
        ])
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
        const PKT_CHANNEL0 = Buffer.from('\x40\x00')
        const SPEECHD = Buffer.concat([Buffer.from('\x00'), speechPacket.data])
        const CMODE = Buffer.from('\x02\x00\x00\x00')
        const TONE = Buffer.from('\x08\x00\x00\x00')
        this.#sp.write(DVstick30.encodePacket('speech', Buffer.concat([ PKT_CHANNEL0, SPEECHD, CMODE, TONE ])))

        throw new Error('Not implemented')
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
            case DVSTICK_PACKET_TYPE.CONTROL:
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

type DecodedPacket = ControlResponse

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

stick.packets.subscribe((packet) => console.log(packet))

; (async () => {
    try {
        await stick.reset()
        const version = await stick.getVersion()
        console.log(`version is ${version}`)
    
        const productId = await stick.getProductId()
        console.log(`product id is ${productId}`)
    
        console.log(`set rate result: ${await stick.setRateT(33)}`)

        console.log(`init result: ${await stick.init()}`)
    } catch (err) {
        console.error(err)
    } finally {
        serialport.close()
    }
})()



// self._device_name = device
// self._baudrate = baudrate
// self._MODEL = 'AMBE3000R'
// self.buffer = b''
// self._start_byte = b'\x61'
// self._TYPE_PCM = 0x2
// self._TYPE_AMBE = 0x1
// self._TYPE_CTRL = 0x0
// self._type = { 'cfg':b'\x00', 'speech':b'\x02','channel':b'\x01' }

