#!/bin/bash
# script to update the server binary and data for the server (includes html pages)

if [ $# -eq 0 ] ; then
    echo No arguments, installing release server in ~/apps/local_server
    install_path=~/apps/home_server
    build_type=Release
elif [ $# -eq 1 ] ; then
    install_path=~/apps/home_server
    build_type=$1
elif [ $# -eq 2 ] ; then
    install_path=$1
    build_type=$2
else 
    echo If command line parameteres are provided these always have to be
    echo    install/path                \(can be anything\)
    echo    build_type[Release/Debug]   \(only Release/Debug are allowed\)
    echo or
    echo    build_type[Release/Debug]   \(only Release/Debug are allowed\)
    exit 1
fi

#copying all needed files
cp "build/GCC_13.2.0_aarch64-linux-gnu/$build_type/home_server" $install_path/home_server
cp -r templates $install_path
