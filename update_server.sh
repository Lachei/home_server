#!/bin/bash
# script to update the server binary and data for the server (includes html pages)

if [ $# -eq 0 ] then
    echo No arguments, installing release server in ~/apps/local_server
    install_path=~/apps/local_server
    build_type=Release
else
if [ $# -ne 2] then
    echo If command line parameteres are provided these always have to be
    echo    install/path                \(can be anything\)
    echo    build_type[Release/Debug]   \(only Release/Debug are allowed\)
    exit 1
else
    install_path=$1
    build_type=$2
fi
fi

#copying all needed files
cp $install_path/home_server "build/GCC 13.2.0 aarch64-linux-gnu/Debug/home_server"
cp -r $install_path/templates templates