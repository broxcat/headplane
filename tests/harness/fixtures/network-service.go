// A real listener for isolated policy tests; no external dependencies or LAN IO.
package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

func main() {
	if os.Args[1] == "udp-serve" {
		socket, err := net.ListenPacket("udp", "127.0.0.1:"+os.Args[2])
		if err != nil {
			panic(err)
		}
		buffer := make([]byte, 512)
		for {
			_, addr, err := socket.ReadFrom(buffer)
			if err != nil {
				panic(err)
			}
			socket.WriteTo([]byte("headplane-network-ok\n"), addr)
		}
	}
	if os.Args[1] == "probe-udp" {
		socket, err := net.Dial("unix", "/var/run/tailscale/tailscaled.sock")
		if err != nil {
			panic(err)
		}
		defer socket.Close()
		socket.SetDeadline(time.Now().Add(2 * time.Second))
		fmt.Fprintf(socket, "POST /localapi/v0/dial HTTP/1.1\r\nHost: local-tailscaled.sock\r\nUpgrade: ts-dial\r\nConnection: upgrade\r\nDial-Host: %s\r\nDial-Port: %s\r\nDial-Network: udp\r\nContent-Length: 0\r\n\r\n", os.Args[2], os.Args[3])
		reader := bufio.NewReader(socket)
		response, err := http.ReadResponse(reader, nil)
		if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
			os.Exit(2)
		}
		if _, err := socket.Write([]byte("probe\n")); err != nil {
			os.Exit(2)
		}
		message, err := reader.ReadString('\n')
		if err != nil {
			os.Exit(2)
		}
		fmt.Print(message)
		return
	}
	if os.Args[1] == "probe" || os.Args[1] == "stream" {
		proxy, _ := url.Parse("socks5://127.0.0.1:1055")
		client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(proxy)}}
		path := "/"
		if os.Args[1] == "stream" {
			client.Timeout = time.Hour
			path = "/stream"
		}
		response, err := client.Get("http://" + net.JoinHostPort(os.Args[2], os.Args[3]) + path)
		if err != nil {
			os.Exit(2)
		}
		defer response.Body.Close()
		if os.Args[1] == "stream" {
			scanner := bufio.NewScanner(response.Body)
			for scanner.Scan() {
				os.WriteFile(os.Args[4], []byte(fmt.Sprint(time.Now().UnixMilli())), 0600)
			}
			return
		}
		io.Copy(os.Stdout, response.Body)
		return
	}
	server := &http.Server{
		Addr:              "0.0.0.0:" + os.Args[1],
		ReadHeaderTimeout: 3 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/stream" {
				ticker := time.NewTicker(50 * time.Millisecond)
				defer ticker.Stop()
				for {
					select {
					case <-r.Context().Done():
						return
					case <-ticker.C:
						if _, err := fmt.Fprintln(w, "headplane-network-ok"); err != nil {
							return
						}
						if err := http.NewResponseController(w).Flush(); err != nil {
							return
						}
					}
				}
			}
			fmt.Fprintln(w, "headplane-network-ok")
		}),
	}
	if err := server.ListenAndServe(); err != nil {
		panic(err)
	}
}
