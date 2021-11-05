import { filter, firstValueFrom, Observable, Subject } from 'rxjs'
import SerialPort from 'serialport'

const device = '/dev/ttyUSB0'

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

    static encodePacket(payloadType: number, payload: Buffer): Buffer {
        const lengthBuffer = Buffer.alloc(2, 0)
        lengthBuffer.writeUInt16BE(payload.length)
        const payloadTypeBuffer = Buffer.alloc(1, 0)
        payloadTypeBuffer.writeUInt8(payloadType)
    
        return Buffer.concat([
            Buffer.from('61', 'hex'), // magic number   
            lengthBuffer,
            payloadTypeBuffer,
            payload
        ])
    }

    async setRateT (rate: number) {
        this.#sp.write(DVstick30.encodePacket(0, Buffer.from('\x09' + String.fromCharCode(rate))))

        await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'control-response' && packet.controlPacketType === 'PKT_RATET')))
    }

    async getVersion () {
        const versionControl = '\x31'
        this.#sp.write(DVstick30.encodePacket(0, Buffer.from(versionControl)))

        const reply = await firstValueFrom(this.#packets.pipe(filter((packet) => packet.type === 'control-response' && packet.controlPacketType === 'PKT_VERSTRING')))
        
        return (reply as ControlResponseVersion).versionString
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

type ControlResponseVersion = {
    type: 'control-response'
    controlPacketType: 'PKT_VERSTRING'
    versionString: string
}

type ControlResponseRateT = {
    type: 'control-response'
    controlPacketType: 'PKT_RATET'
}

type ControlResponse = ControlResponseVersion | ControlResponseRateT | {
    type: 'control-response',
    controlPacketType: 'unknown',
    fieldIdentifier: number,
    payload: Buffer
}

stick.packets.subscribe((packet) => console.log(packet))

stick.getVersion().then((version) => console.log(`version is ${version}`))
stick.setRateT(33)

setTimeout(() => serialport.close(), 1000)

// self._device_name = device
// self._baudrate = baudrate
// self._MODEL = 'AMBE3000R'
// self.buffer = b''
// self._start_byte = b'\x61'
// self._TYPE_PCM = 0x2
// self._TYPE_AMBE = 0x1
// self._TYPE_CTRL = 0x0
// self._type = { 'cfg':b'\x00', 'speech':b'\x02','channel':b'\x01' }

