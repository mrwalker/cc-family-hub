' Family Hub for Roku: the same screen runs as the channel (channel.brs) and the screensaver.

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
    ' Focus once the scene is on screen, so it receives remote keys.
    scene.setFocus(true)
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" and msg.isScreenClosed() then return
    end while
end sub
