' Family Hub for Roku: the channel, and the same screen as a screensaver.

sub Main(args as dynamic)
    RunHub(false)
end sub

sub RunScreenSaver()
    RunHub(true)
end sub

sub RunHub(screensaver as boolean)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    scene = screen.CreateScene("HubScene")
    screen.show()
    scene.screensaver = screensaver
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" and msg.isScreenClosed() then return
    end while
end sub
