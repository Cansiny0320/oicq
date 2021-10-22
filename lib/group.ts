import { randomBytes } from "crypto"
import axios from "axios"
import { pb, jce } from "./core"
import { ErrorCode, drop } from "./errors"
import { timestamp, code2uin, PB_CONTENT, NOOP } from "./common"
import { ShitMountain } from "./internal"
import { GroupMember } from "./member"
import { Sendable, GroupMessage, ImageElem, Image, buildMusic, MusicPlatform, Converter, Anonymous, parseGroupMessageId } from "./message"
import { Gfs } from "./gfs"
import { MessageRet } from "./events"
import { GroupInfo, MemberInfo } from "./entities"

type Client = import("./client").Client

export interface AnonymousInfo extends Omit<Anonymous, "flag"> {
	enable: boolean
}

const fetchmap = new Map<string, Promise<Map<number, MemberInfo>>>()
const weakmap = new WeakMap<GroupInfo, Group>()

const GI_BUF = pb.encode({
	1: 0,
	2: 0,
	5: 0,
	6: 0,
	15: "",
	29: 0,
	36: 0,
	37: 0,
	45: 0,
	46: 0,
	49: 0,
	54: 0,
	89: "",
})

export class Discuss extends ShitMountain {
	static as(this: Client, gid: number) {
		return new Discuss(this, Number(gid))
	}
	protected constructor(c: Client, public readonly gid: number) {
		super(c)
	}
	/** 发送一条消息 */
	async sendMessage(content: Sendable): Promise<MessageRet> {
		const { rich, brief } = await this._preprocess(content)
		const body = pb.encode({
			1: { 4: { 1: this.gid } },
			2: PB_CONTENT,
			3: { 1: rich },
			4: randomBytes(2).readUInt16BE(),
			5: randomBytes(4).readUInt32BE(),
			8: 0,
		})
		const payload = await this.c.sendUni("MessageSvc.PbSendMsg", body)
		const rsp = pb.decode(payload)
		if (rsp[1] !== 0) {
			this.c.logger.error(`failed to send: [Discuss(${this.gid})] ${rsp[2]}(${rsp[1]})`)
			drop(rsp[1], rsp[2])
		}
		this.c.logger.info(`succeed to send: [Discuss(${this.gid})] ` + brief)
		return {
			message_id: "",
			seq: 0,
			rand: 0,
			time: 0,
		}
	}
}

export interface Group {
	recallMessage(msg: GroupMessage): Promise<boolean>
	recallMessage(msgid: string): Promise<boolean>
	recallMessage(seq: number, rand: number, pktnum?: number): Promise<boolean>
}

export class Group extends Discuss {

	/** 群资料 */
	get info() {
		if (!this._info || timestamp() - this._info?.update_time! >= 900)
			this.fetchInfo().catch(NOOP)
		return this._info
	}

	/** 文件系统 */
	readonly fs: Gfs

	/** 若gid相同则每次返回同一对象 */
	static as(this: Client, gid: number) {
		const info = this.gl.get(gid)
		let group = weakmap.get(info!)
		if (group) return group
		group = new Group(this, Number(gid), info)
		if (info) 
			weakmap.set(info, group)
		return group
	}

	private constructor(c: Client, gid: number, private _info?: GroupInfo) {
		super(c, gid)
		this.fs = new Gfs(c, gid)
	}

	/** 获取一枚群员实例 */
	acquireMember(uid: number) {
		return GroupMember.as.call(this.c, this.gid, uid)
	}

	/** 强制刷新资料 */
	async fetchInfo(): Promise<GroupInfo> {
		const body = pb.encode({
			1: this.c.apk.subid,
			2: {
				1: this.gid,
				2: GI_BUF,
			},
		})
		if (this._info)
			this._info.update_time = timestamp()
		const payload = await this.c.sendOidb("OidbSvc.0x88d_0", body)
		const proto = pb.decode(payload)[4][1][3]
		if (!proto) {
			this.c.gl.delete(this.gid)
			this.c.gml.delete(this.gid)
			drop(ErrorCode.GroupNotJoined)
		}
		let info: GroupInfo = {
			group_id: this.gid,
			group_name: proto[89] ? String(proto[89]) : String(proto[15]),
			member_count: proto[6],
			max_member_count: proto[5],
			owner_id: proto[1],
			last_join_time: proto[49],
			last_sent_time: proto[54],
			shutup_time_whole: proto[45] ? 0xffffffff : 0,
			shutup_time_me: proto[46] > timestamp() ? proto[46] : 0,
			create_time: proto[2],
			grade: proto[36],
			max_admin_count: proto[29],
			active_member_count: proto[37],
			update_time: timestamp(),
		}
		info = Object.assign(this.c.gl.get(this.gid) || this._info || { }, info)
		this.c.gl.set(this.gid, info)
		this._info = info
		weakmap.set(info, this)
		return info
	}

	private async _fetchMemberList() {
		let next = 0
		while (true) {
			const GTML = jce.encodeStruct([
				this.c.uin, this.gid, next, code2uin(this.gid), 2, 0, 0, 0
			])
			const body = jce.encodeWrapper({ GTML }, "mqq.IMService.FriendListServiceServantObj", "GetTroopMemberListReq")
			const payload = await this.c.sendUni("friendlist.GetTroopMemberListReq", body, 10)
			const nested = jce.decodeWrapper(payload)
			next = nested[4]
			if (!this.c.gml.has(this.gid))
				this.c.gml.set(this.gid, new Map)
			for (let v of nested[3]) {
				let info: MemberInfo = {
					group_id: this.gid,
					user_id: v[0],
					nickname: v[4] || "",
					card: v[8] || "",
					sex: (v[3] ? (v[3] === -1 ? "unknown" : "female") : "male"),
					age: v[2] || 0,
					join_time: v[15],
					last_sent_time: v[16],
					level: v[14],
					role: v[18] % 2 === 1 ? "admin" : "member",
					title: v[23],
					title_expire_time: v[24] & 0xffffffff,
					shutup_time: v[30] > timestamp() ? v[30] : 0,
					update_time: 0,
				}
				const list = this.c.gml.get(this.gid)!
				info = Object.assign(list.get(v[0]) || { }, info)
				if (this.c.gl.get(this.gid)?.owner_id === v[0])
					info.role = "owner"
				list.set(v[0], info)
			}
			if (!next) break
		}
		const mlist = this.c.gml.get(this.gid)!
		if (!mlist.size || !this.c.config.cache_group_member)
			this.c.gml.delete(this.gid)
		return mlist
	}

	/** 获取群员列表 */
	async getMemberList(no_cache = false) {
		const k = this.c.uin + "-" + this.gid
		const fetching = fetchmap.get(k)
		if (fetching) return fetching
		const mlist = this.c.gml.get(this.gid)
		if (!mlist || no_cache) {
			const fetching = this._fetchMemberList()
			fetchmap.set(k, fetching)
			return fetching
		} else {
			return mlist
		}
	}

	/** 发送音乐分享 */
	async shareMusic(platform: MusicPlatform, id: string) {
		const body = await buildMusic(this.gid, platform, id, 1)
		await this.c.sendOidb("OidbSvc.0xb77_9", pb.encode(body))
	}

	/** 发送一条消息 */
	async sendMessage(content: Sendable, anonymous: AnonymousInfo | boolean = false): Promise<MessageRet> {
		const converter = await this._preprocess(content)
		if (anonymous) {
			if (anonymous === true)
				anonymous = await this.getAnonymousInfo()
			converter.anonymize(anonymous)
		}
		const rand = randomBytes(4).readUInt32BE()
		const body = pb.encode({
			1: { 2: { 1: this.gid } },
			2: PB_CONTENT,
			3: { 1: converter.rich },
			4: randomBytes(2).readUInt16BE(),
			5: rand,
			8: 0,
		})

		const e = `internal.${this.gid}.${rand}`
		let message_id = ""
		this.c.once(e, (id) => message_id = id)
		try {
			const payload = await this.c.sendUni("MessageSvc.PbSendMsg", body)
			const rsp = pb.decode(payload)
			if (rsp[1] !== 0) {
				this.c.logger.error(`failed to send: [Group: ${this.gid}] ${rsp[2]}(${rsp[1]})`)
				drop(rsp[1], rsp[2])
			}
		} finally {
			this.c.removeAllListeners(e)
		}

		// 分片专属屎山
		try {
			if (!message_id) {
				const time = this.c.config.resend ? 5000 : (converter.length <= 80 ? 2000 : 500)
				message_id = await new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						this.c.removeAllListeners(e)
						reject()
					}, time)
					this.c.once(e, (id) => {
						clearTimeout(timeout)
						resolve(id)
					})
				})
			}
		} catch {
			if (this.c.config.resend)
				message_id = await this._sendMessageByFragments(converter.toFragments())
			else
				drop(ErrorCode.RiskMessageFailure)
		}
		this.c.logger.info(`succeed to send: [Group(${this.gid})] ` + converter.brief)
		{
			const { seq, rand, time } = parseGroupMessageId(message_id)
			return { seq, rand, time, message_id}
		}
	}

	// 分片专属屎山
	private async _sendMessageByFragments(fragments: Uint8Array[]) {
		let n = 0
		const rand = randomBytes(4).readUInt32BE()
		const div = randomBytes(2).readUInt16BE()
		for (let frag of fragments) {
			const body = pb.encode({
				1: { 2: { 1: this.gid } },
				2: {
					1: fragments.length,
					2: n++,
					3: div
				},
				3: { 1: frag },
				4: randomBytes(2).readUInt16BE(),
				5: rand,
				8: 0,
			})
			this.c.writeUni("MessageSvc.PbSendMsg", body)
		}
		const e = `internal.${this.gid}.${rand}`
		try {
			return await new Promise((resolve: (id: string) => void, reject) => {
				const timeout = setTimeout(() => {
					this.c.removeAllListeners(e)
					reject()
				}, 5000)
				this.c.once(e, (id) => {
					clearTimeout(timeout)
					resolve(id)
				})
			})
		} catch {
			drop(ErrorCode.SensitiveWordsFailure)
		}
	}

	/** 撤回一条消息 */
	async recallMessage(param: number | string | GroupMessage, rand = 0, pktnum = 1) {
		if (param instanceof GroupMessage)
			var { seq, rand, pktnum } = param
		else if (typeof param === "string")
			var { seq, rand, pktnum } = parseGroupMessageId(param)
		else
			var seq = param
		if (pktnum > 1) {
			var msg: any = [], pb_msg = [], n = pktnum!, i = 0
			while (n-- > 0) {
				msg.push(pb.encode({
					1: seq,
					2: rand,
				}))
				pb_msg.push(pb.encode({
					1: seq,
					3: pktnum,
					4: i++
				}))
				++seq
			}
			var reserver: any = {
				1: 1,
				2: pb_msg,
			}
		} else {
			var msg: any = {
				1: seq,
				2: rand,
			}
			var reserver: any = { 1: 0 }
		}
		const body = pb.encode({
			2: {
				1: 1,
				2: 0,
				3: this.gid,
				4: msg,
				5: reserver,
			}
		})
		const payload = await this.c.sendOidb("PbMessageSvc.PbMsgWithDraw", body)
		return pb.decode(payload)[2][1] === 0
	}

	/** 设置群名 */
	setName(name: string) {
		return this._setting({ 3: String(name) })
	}
	/** 群员禁言 */
	muteAll(yes: boolean) {
		return this._setting({ 17: yes ? 0xffffffff : 0 })
	}
	/** 发送简易群公告 */
	announce(content: string) {
		return this._setting({ 4: String(content) })
	}
	private async _setting(obj: {[tag: number]: any}) {
		const body = pb.encode({
			1: this.gid,
			2: obj
		})
		const payload = await this.c.sendOidb("OidbSvc.0x89a_0", body)
		return pb.decode(payload)[3] === 0
	}

	/** 允许/禁止匿名 */
	async allowAnonymous(yes: boolean) {
		const buf = Buffer.allocUnsafe(5)
		buf.writeUInt32BE(this.gid)
		buf.writeUInt8(yes ? 1 : 0, 4)
		const payload = await this.c.sendOidb("OidbSvc.0x568_22", buf)
		return pb.decode(payload)[3] === 0
	}

	/** 设置备注 */
	async setRemark(remark: string) {
		const body = pb.encode({
			1: {
				1: this.gid,
				2: code2uin(this.gid),
				3: String(remark || "")
			}
		})
		await this.c.sendOidb("OidbSvc.0xf16_1", body)
	}

	/** 禁言匿名玩家，默认1800秒 */
	async muteAnonymous(flag: string, duration = 1800) {
		const [nick, id] = flag.split("@")
		const cookie = this.c.cookies["qqweb.qq.com"]
		const body = new URLSearchParams({
			anony_id: id,
			group_code: String(this.gid),
			seconds: String(duration),
			anony_nick: nick,
			bkn: String(this.c.bkn)
		}).toString()
		const rsp = await axios.post("https://qqweb.qq.com/c/anonymoustalk/blacklist", body, {
			headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, timeout: 5000
		})
		if (rsp.status === 200)
			return JSON.parse(String(rsp.data)).retcode === 0
		return false
	}

	/** 获取自己的匿名情报 */
	async getAnonymousInfo(): Promise<AnonymousInfo> {
		const body = pb.encode({
			1: 1,
			10: {
				1: this.c.uin,
				2: this.gid,
			}
		})
		const payload = await this.c.sendUni("group_anonymous_generate_nick.group", body)
		const obj = pb.decode(payload)[11]
		return {
			enable: !obj[10][1],
			name: String(obj[3]),
			id: obj[5],
			id2: obj[4],
			expire_time: obj[6],
			color: String(obj[15]),
		}
	}

	/** 获取 @全体成员 的剩余次数 */
	async getAtAllRemainingTimes() {
		const body = pb.encode({
			1: 1,
			2: 2,
			3: 1,
			4: this.c.uin,
			5: this.gid,
		})
		const payload = await this.c.sendOidb("OidbSvc.0x8a7_0", body)
		return pb.decode(payload)[4][2]
	}

	private async _getLastSeq() {
		const body = pb.encode({
			1: this.c.apk.subid,
			2: {
				1: this.gid,
				2: {
					22: 0
				},
			},
		})
		const payload = await this.c.sendOidb("OidbSvc.0x88d_0", body)
		return pb.decode(payload)[4][1][3][22]
	}

	/** 标记seq之前为已读 */
	async markRead(seq = 0) {
		const body = pb.encode({
			1: {
				1: this.gid,
				2: Number(seq || (await this._getLastSeq()))
			}
		})
		await this.c.sendUni("PbMessageSvc.PbMsgReadedReport", body)
	}

	/** 获取seq之前的cnt条聊天记录，cnt默认20不能超过20 */
	async getChatHistory(seq = 0, cnt = 20) {
		if (cnt > 20) cnt = 20
		if (!seq)
			seq = await this._getLastSeq()
		const from_seq = seq - cnt + 1
		const body = pb.encode({
			1: this.gid,
			2: from_seq,
			3: seq,
			6: 0
		})
		const payload = await this.c.sendUni("MessageSvc.PbGetGroupMsg", body)
		const obj = pb.decode(payload), messages: GroupMessage[] = []
		if (obj[1] > 0 || !obj[6])
			return []
		!Array.isArray(obj[6]) && (obj[6] = [obj[6]])
		for (const proto of obj[6])
			messages.push(new GroupMessage(proto))
		return messages
	}

	/** 获取群文件下载地址 */
	async fetchFileDownloadUrl(fid: string) {
		return (await this.fs.download(fid)).url
	}

	/** 设置群头像 */
	async setPortrait(file: ImageElem["file"]) {
		const img = new Image({ type: "image", file })
		await img.task
		const url = `http://htdata3.qq.com/cgi-bin/httpconn?htcmd=0x6ff0072&ver=5520&ukey=${this.c.sig.skey}&range=0&uin=${this.c.uin}&seq=1&groupuin=${this.gid}&filetype=3&imagetype=5&userdata=0&subcmd=1&subver=101&clip=0_0_0_0&filesize=` + img.size
		await axios.post(url, img.readable)
		img.deleteTmpFile()
	}

	/** 邀请好友入群 */
	async invite(uid: number) {
		const body = pb.encode({
			1: this.gid,
			2: {
				1: Number(uid)
			}
		})
		const payload = await this.c.sendOidb("OidbSvc.oidb_0x758", body)
		return pb.decode(payload)[4].toBuffer().length > 6
	}

	/** 退群/解散 */
	async quit() {
		const buf = Buffer.allocUnsafe(8)
		buf.writeUInt32BE(this.c.uin)
		buf.writeUInt32BE(this.gid, 4)
		const GroupMngReq = jce.encodeStruct([
			2, this.c.uin, buf
		])
		const body = jce.encodeWrapper({ GroupMngReq }, "KQQ.ProfileService.ProfileServantObj", "GroupMngReq")
		const payload = await this.c.sendUni("ProfileService.GroupMngReq", body)
		return jce.decodeWrapper(payload)[1] === 0
	}

	setAdmin(uid: number, yes: boolean) {
		return this.acquireMember(uid).setAdmin(yes)
	}
	setSpecialTitle(uid: number, title: string, duration = -1) {
		return this.acquireMember(uid).setSpecialTitle(title, duration)
	}
	setCard(uid: number, card: string) {
		return this.acquireMember(uid).setCard(card)
	}
	kickMember(uid: number, block = false) {
		return this.acquireMember(uid).kick(block)
	}
	muteMember(uid: number, duration = 600) {
		return this.acquireMember(uid).mute(duration)
	}
	pokeMember(uid: number) {
		return this.acquireMember(uid).poke()
	}
}
