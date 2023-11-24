cmake_minimum_required(VERSION 3.15.0 FATAL_ERROR)
project(home_server)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED TRUE)

find_package(Boost REQUIRED)

file(GLOB SRC "src/*")
add_executable(home_server ${SRC})
target_link_libraries(home_server Boost::boost)

include(CTest)
add_subdirectory(tests)