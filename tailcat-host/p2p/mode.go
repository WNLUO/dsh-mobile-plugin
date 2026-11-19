// 一条隧道往哪边拨。
//
// 两端跑的是同一份代码，区别只有这个：手机主动拨电脑（`dial`），电脑在隧道里听
// （`accept`）。这样配对时谁先起、谁后起都不会卡住——手机不在时电脑的隧道就那样空听着，
// 手机来了自然连上。
package p2p

// Mode 决定这条隧道往哪边拨。
type Mode string

const (
	// ModeDial 是手机侧：本机开一个回环端口，每条连接穿隧道到电脑。
	ModeDial Mode = "dial"
	// ModeAccept 是电脑侧：在隧道里听一个端口，进来什么就转给本机插件。
	ModeAccept Mode = "accept"
)
