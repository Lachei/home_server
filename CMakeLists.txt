cmake_minimum_required(VERSION 3.15.0 FATAL_ERROR)
project(home_server)

add_subdirectory(Crow)

file(GLOB SRC "src/*")
add_executable(home_server ${SRC})
target_link_libraries(home_server Crow::Crow)