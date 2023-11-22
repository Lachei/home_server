cmake_minimum_required(VERSION 3.15.0 FATAL_ERROR)
project(home_server)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED TRUE)
file(GLOB SRC "src/*")
add_executable(home_server ${SRC})

include(CTest)
add_subdirectory(tests)